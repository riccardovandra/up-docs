import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import { isVideoLanguage, parseVideoBlock, type VideoBlock } from "../../../shared/video.ts";
import "./video.css";

const PROVIDER_NAMES = { youtube: "YouTube", loom: "Loom" } as const;

const PLAYER_SANDBOX =
  "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";
const PLAYER_ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media";

function link(href: string, text: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = text;
  return anchor;
}

/**
 * A ```t3-video block. YouTube and Loom show a placeholder and contact the
 * provider only when the reader clicks it; uploaded files use a plain <video>.
 * "Edit" (or the caret entering the block) shows the source, which also stays
 * visible while it is not a video we can play.
 */
export class VideoView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("code");
  private readonly stage = document.createElement("div");
  private readonly meta = document.createElement("div");
  private readonly print = document.createElement("div");
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: ProseMirrorNode;
  private source: string | null = null;

  constructor(
    { node, editor, getPos }: NodeViewRendererProps,
    openSource: (editor: Editor, pos: number, node: ProseMirrorNode) => void,
  ) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;

    this.dom.className = "video-block";
    const pre = document.createElement("pre");
    pre.className = "video-source";
    pre.append(this.contentDOM);
    const chrome = document.createElement("div");
    chrome.className = "video-chrome";
    chrome.contentEditable = "false";
    this.stage.className = "video-stage";
    this.meta.className = "video-meta";
    this.print.className = "video-print";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "video-edit";
    editButton.textContent = "Edit";
    editButton.addEventListener("mousedown", (event) => event.preventDefault());
    editButton.addEventListener("click", () => {
      const pos = this.getPos();
      if (this.editor.isEditable && typeof pos === "number") {
        openSource(this.editor, pos, this.node);
      }
    });
    chrome.append(this.stage, this.meta, this.print, editButton);
    this.dom.append(pre, chrome);

    editor.on("selectionUpdate", this.syncEditing);
    editor.on("focus", this.syncEditing);
    editor.on("blur", this.syncEditing);
    this.show(node.textContent);
    this.syncEditing();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !isVideoLanguage(node.attrs.language as string | null)) {
      return false;
    }
    this.node = node;
    this.show(node.textContent);
    this.syncEditing();
    return true;
  }

  // The player and its links are ours, not ProseMirror's.
  stopEvent(event: Event) {
    return event.target instanceof Node && !this.contentDOM.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target);
  }

  destroy() {
    this.editor.off("selectionUpdate", this.syncEditing);
    this.editor.off("focus", this.syncEditing);
    this.editor.off("blur", this.syncEditing);
  }

  /** Rebuilds only when the text changes, so a playing video survives other edits. */
  private show(source: string) {
    if (source === this.source) return;
    this.source = source;
    const video = parseVideoBlock(source);
    this.dom.dataset.state = video ? "ready" : "invalid";
    this.stage.replaceChildren();
    this.meta.replaceChildren();
    this.print.replaceChildren();
    if (!video) {
      const message = document.createElement("p");
      message.className = "video-message";
      message.textContent =
        source.trim() === "" ? "Paste a YouTube or Loom link." : "Unsupported video link.";
      this.stage.replaceChildren(message);
      return;
    }
    if (video.kind === "file") this.showFile(video);
    else this.showPlaceholder(video);
    const title = video.title ?? "Video";
    const href = new URL(video.watchUrl, window.location.href).href;
    this.print.append(document.createTextNode(`${title}: `), link(href, href));
  }

  private showFile(video: Extract<VideoBlock, { kind: "file" }>) {
    const player = document.createElement("video");
    player.className = "video-player";
    player.controls = true;
    player.preload = "metadata";
    player.playsInline = true;
    player.src = video.src;
    player.setAttribute("aria-label", video.title ?? "Video");
    player.addEventListener("error", () => {
      const message = document.createElement("p");
      message.className = "video-message";
      message.append("This browser cannot play this video. ");
      message.append(link(video.src, "Open it directly"));
      this.stage.replaceChildren(message);
    });
    this.stage.replaceChildren(player);
    if (video.title) this.meta.append(this.titleLine(video.title));
  }

  private showPlaceholder(video: Extract<VideoBlock, { kind: "youtube" | "loom" }>) {
    const provider = PROVIDER_NAMES[video.kind];
    const play = document.createElement("button");
    play.type = "button";
    play.className = "video-play";
    play.setAttribute("aria-label", `Play ${video.title ?? `${provider} video`}`);
    const icon = document.createElement("span");
    icon.className = "video-play-icon";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "video-provider";
    name.textContent = provider;
    play.append(icon, name);
    play.addEventListener("click", () => this.startPlayer(video));
    this.stage.replaceChildren(play);
    if (video.title) this.meta.append(this.titleLine(video.title));
    this.meta.append(link(video.watchUrl, `Open on ${provider}`));
  }

  /** Nothing loads from the provider until this runs. */
  private startPlayer(video: Extract<VideoBlock, { kind: "youtube" | "loom" }>) {
    const frame = document.createElement("iframe");
    frame.className = "video-player";
    frame.setAttribute("sandbox", PLAYER_SANDBOX);
    frame.setAttribute("allow", PLAYER_ALLOW);
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.title = video.title ?? `${PROVIDER_NAMES[video.kind]} video`;
    frame.src = video.embedUrl;
    this.stage.replaceChildren(frame);
  }

  private titleLine(title: string) {
    const line = document.createElement("span");
    line.className = "video-title";
    line.textContent = title;
    return line;
  }

  private readonly syncEditing = () => {
    const pos = this.getPos();
    const { from, to } = this.editor.state.selection;
    const editing =
      this.editor.isFocused &&
      typeof pos === "number" &&
      from > pos &&
      to < pos + this.node.nodeSize;
    this.dom.toggleAttribute("data-editing", editing);
  };
}
