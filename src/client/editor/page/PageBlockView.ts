import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import {
  DEFAULT_PAGE_HEIGHT,
  isPageLanguage,
  PAGE_SANDBOX,
  pagePath,
  parsePageBlock,
  type PageBlock,
} from "../../../shared/htmlPages.ts";
import { ApiError } from "../../api.ts";
import { pagesApi } from "../../htmlPages/pagesApi.ts";
import { publicShare } from "../../publicMode.ts";
import "../../htmlPages/pages.css";

/**
 * A ```t3-page block: an uploaded HTML page from the library, shown in a
 * sandboxed frame at its current version. "Edit" (or the caret entering the
 * block) shows the source, which also stays visible while it is not a page id.
 * A public link never shows a page: only a link to it.
 */
export class PageBlockView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("code");
  private readonly chrome = document.createElement("div");
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private readonly openSource: (editor: Editor, pos: number, node: ProseMirrorNode) => void;
  private node: ProseMirrorNode;
  private source: string | null = null;
  private destroyed = false;

  constructor(
    { node, editor, getPos }: NodeViewRendererProps,
    openSource: (editor: Editor, pos: number, node: ProseMirrorNode) => void,
  ) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.openSource = openSource;

    this.dom.className = "page-embed";
    const pre = document.createElement("pre");
    pre.className = "page-embed-source";
    pre.append(this.contentDOM);
    this.chrome.contentEditable = "false";
    this.dom.append(pre, this.chrome);

    editor.on("selectionUpdate", this.syncEditing);
    editor.on("focus", this.syncEditing);
    editor.on("blur", this.syncEditing);
    this.show(node.textContent);
    this.syncEditing();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !isPageLanguage(node.attrs.language as string | null)) {
      return false;
    }
    this.node = node;
    this.show(node.textContent);
    this.syncEditing();
    return true;
  }

  // The frame and its links are ours, not ProseMirror's.
  stopEvent(event: Event) {
    return event.target instanceof Node && !this.contentDOM.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target);
  }

  destroy() {
    this.destroyed = true;
    this.editor.off("selectionUpdate", this.syncEditing);
    this.editor.off("focus", this.syncEditing);
    this.editor.off("blur", this.syncEditing);
  }

  /** Rebuilds only when the text changes, so a page in use survives other edits. */
  private show(source: string) {
    if (source === this.source) return;
    this.source = source;
    const block = parsePageBlock(source);
    this.dom.dataset.state = block ? "linked" : "invalid";
    if (!block) {
      this.render(
        null,
        this.message(
          source.trim() === ""
            ? "Paste a page id from the Pages library."
            : "This is not a page link. Its first line must be the id of a page.",
        ),
      );
      return;
    }
    if (publicShare()) {
      this.render(block, this.message("An interactive page. Sign in to UP Docs to open it."));
      return;
    }
    this.render(block, this.message("Loading page…"));
    pagesApi.get(block.pageId).then(
      (page) => {
        if (this.destroyed || this.source !== source) return;
        const frame = document.createElement("iframe");
        frame.className = "page-block-frame";
        frame.title = block.caption ?? page.title;
        frame.setAttribute("sandbox", PAGE_SANDBOX);
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("loading", "lazy");
        frame.style.height = `${block.height ?? DEFAULT_PAGE_HEIGHT}px`;
        frame.src = pagesApi.contentUrl(page.id, page.version);
        this.render(block, frame, page.title);
      },
      (cause: unknown) => {
        if (this.destroyed || this.source !== source) return;
        this.render(
          block,
          this.message(
            cause instanceof ApiError && cause.status === 404
              ? "No access to this page, or it was deleted."
              : "Could not load this page.",
          ),
        );
      },
    );
  }

  private render(block: PageBlock | null, body: HTMLElement, title?: string) {
    const card = document.createElement("div");
    card.className = "page-block";
    const bar = document.createElement("div");
    bar.className = "page-block-bar";
    const name = document.createElement("span");
    name.className = "page-block-title";
    name.textContent = title ?? "Page";
    const actions = document.createElement("span");
    actions.className = "page-block-actions";
    if (block && !publicShare()) {
      const open = document.createElement("a");
      open.className = "page-block-open";
      open.href = pagePath(block.pageId);
      open.target = "_blank";
      open.rel = "noopener";
      open.textContent = "Open";
      actions.append(open);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "page-block-edit";
    edit.textContent = "Edit";
    edit.addEventListener("mousedown", (event) => event.preventDefault());
    edit.addEventListener("click", () => {
      const pos = this.getPos();
      if (this.editor.isEditable && typeof pos === "number") this.openSource(this.editor, pos, this.node);
    });
    actions.append(edit);
    bar.append(name, actions);
    card.append(bar, body);
    if (block?.caption) {
      const caption = document.createElement("div");
      caption.className = "page-block-caption";
      caption.textContent = block.caption;
      card.append(caption);
    }
    this.chrome.replaceChildren(card);
  }

  private message(text: string) {
    const message = document.createElement("p");
    message.className = "page-block-empty";
    message.textContent = text;
    return message;
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
