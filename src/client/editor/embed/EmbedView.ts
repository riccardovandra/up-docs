import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import {
  type EmbedBlock,
  type EmbedSnapshot,
  type EmbedTarget,
  isEmbedLanguage,
  parseEmbedBlock,
  PROVIDER_NAMES,
} from "../../../shared/embeds.ts";
import { isDocImageSrc } from "../../../shared/images.ts";
import type { EmbedSupportStorage } from "./embedSupport.ts";
import "./embed.css";

/**
 * The provider's own embed page, on request. Its scripts run in the
 * provider's origin, never ours; it cannot navigate the doc, submit forms or
 * open dialogs. Popups (its own links) open in a new tab.
 */
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** Lines of post text shown before "Show more". */
const CLAMP_CHARS = 600;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(href: string, text: string, className = "embed-link"): HTMLAnchorElement {
  const anchor = el("a", className, text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", onClick);
  return node;
}

const numberFormat = new Intl.NumberFormat(undefined, { notation: "compact" });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatDate(value: string | number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * A ```t3-embed block. A LinkedIn or X link shows the doc's saved copy of the
 * post (text set as plain text, image served from the doc's own images), with
 * the provider's live embed one click away where it has one. Any other link,
 * or a post whose copy cannot be taken, shows a link card. "Edit" (or the caret
 * entering the block) shows the source.
 */
export class EmbedView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("code");
  private readonly stage = el("div", "embed-stage");
  private readonly caption = el("div", "embed-caption");
  private readonly print = el("div", "embed-print");
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: ProseMirrorNode;
  private source: string | null = null;
  /** Bumped on every rebuild, so a late response for an old link is dropped. */
  private generation = 0;
  private destroyed = false;

  constructor(
    { node, editor, getPos }: NodeViewRendererProps,
    openSource: (editor: Editor, pos: number, node: ProseMirrorNode) => void,
  ) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;

    this.dom.className = "embed-block";
    const pre = el("pre", "embed-source");
    pre.append(this.contentDOM);
    const chrome = el("div", "embed-chrome");
    chrome.contentEditable = "false";
    const editButton = button("Edit", "embed-edit", () => {
      const pos = this.getPos();
      if (this.editor.isEditable && typeof pos === "number")
        openSource(this.editor, pos, this.node);
    });
    chrome.append(this.stage, this.caption, this.print, editButton);
    this.dom.append(pre, chrome);

    editor.on("selectionUpdate", this.syncEditing);
    editor.on("focus", this.syncEditing);
    editor.on("blur", this.syncEditing);
    this.show(node.textContent);
    this.syncEditing();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !isEmbedLanguage(node.attrs.language as string | null)) {
      return false;
    }
    this.node = node;
    this.show(node.textContent);
    this.syncEditing();
    return true;
  }

  // The card, its buttons and the live frame are ours, not ProseMirror's.
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

  private get support(): EmbedSupportStorage | undefined {
    return (this.editor.storage as { embedSupport?: EmbedSupportStorage }).embedSupport;
  }

  /** Rebuilds only when the text changes, so an open live post survives other edits. */
  private show(source: string) {
    if (source === this.source) return;
    this.source = source;
    this.generation += 1;
    const block = parseEmbedBlock(source);
    this.caption.replaceChildren();
    this.print.replaceChildren();
    if (!block) {
      this.dom.dataset.state = "invalid";
      const message = el(
        "p",
        "embed-message",
        source.trim() === "" ? "Paste a LinkedIn or X link." : "This is not an https link.",
      );
      this.stage.replaceChildren(message);
      return;
    }
    if (block.caption) this.caption.textContent = block.caption;
    const href = block.target?.canonicalUrl ?? block.url;
    this.print.append(
      document.createTextNode(`${block.caption ?? hostOf(href)}: `),
      link(href, href),
    );
    if (!block.target || !this.support?.load) {
      this.dom.dataset.state = "link";
      this.stage.replaceChildren(this.linkCard(block, null));
      return;
    }
    this.load(block, block.target, false);
  }

  private load(block: EmbedBlock, target: EmbedTarget, refresh: boolean) {
    const support = this.support;
    if (!support?.load) return;
    const generation = this.generation;
    this.dom.dataset.state = "loading";
    if (!refresh) this.stage.replaceChildren(this.skeleton(target));
    const key = target.canonicalUrl;
    const previous = support.cache.get(key);
    let pending = refresh ? undefined : previous;
    if (!pending) {
      pending = support.load(block.url, refresh);
      support.cache.set(key, pending);
      // A failure is not kept, so the next open tries again.
      pending.catch(() => {
        if (support.cache.get(key) === pending) support.cache.delete(key);
      });
    }
    pending.then(
      (snapshot) => {
        if (this.destroyed || generation !== this.generation) return;
        this.dom.dataset.state = "ready";
        this.stage.replaceChildren(this.card(block, target, snapshot));
      },
      () => {
        if (this.destroyed || generation !== this.generation) return;
        // A failed refresh keeps the copy the doc already has.
        if (refresh && previous) {
          support.cache.set(key, previous);
          void previous.then((snapshot) => {
            if (this.destroyed || generation !== this.generation) return;
            this.dom.dataset.state = "ready";
            const card = this.card(block, target, snapshot);
            card.append(
              el("p", "embed-note", "Could not refresh the copy. The saved one is shown."),
            );
            this.stage.replaceChildren(card);
          });
          return;
        }
        this.dom.dataset.state = "link";
        this.stage.replaceChildren(
          this.linkCard(block, "The post could not be loaded. It may be private or deleted."),
        );
      },
    );
  }

  private skeleton(target: EmbedTarget) {
    const card = el("div", "embed-card embed-card-loading");
    card.setAttribute("aria-busy", "true");
    card.append(el("span", "embed-provider", `Loading ${PROVIDER_NAMES[target.provider]} post…`));
    return card;
  }

  private card(block: EmbedBlock, target: EmbedTarget, snapshot: EmbedSnapshot) {
    const provider = PROVIDER_NAMES[target.provider];
    const card = el("article", "embed-card");
    card.dataset.provider = target.provider;

    const head = el("header", "embed-head");
    const who = el("div", "embed-who");
    if (snapshot.author) who.append(el("span", "embed-author", snapshot.author));
    if (snapshot.handle) who.append(el("span", "embed-handle", `@${snapshot.handle}`));
    head.append(who, el("span", "embed-provider", provider));
    card.append(head);

    // LinkedIn's headline is the post's first sentence; show it only when the text does not.
    if (snapshot.title && !snapshot.text?.startsWith(snapshot.title.replace(/…$/, ""))) {
      card.append(el("p", "embed-title", snapshot.title));
    }
    if (snapshot.text) card.append(this.postText(snapshot.text));
    if (snapshot.image && isDocImageSrc(snapshot.image)) {
      const image = el("img", "embed-image");
      image.src = snapshot.image;
      image.alt = snapshot.author
        ? `Image from ${snapshot.author}'s post`
        : `Image from the ${provider} post`;
      image.loading = "lazy";
      image.decoding = "async";
      card.append(image);
    }

    const foot = el("footer", "embed-foot");
    const facts = [
      formatDate(snapshot.publishedAt),
      snapshot.likes === null ? null : `${numberFormat.format(snapshot.likes)} likes`,
      snapshot.comments === null ? null : `${numberFormat.format(snapshot.comments)} comments`,
    ].filter((fact): fact is string => fact !== null);
    if (facts.length > 0) foot.append(el("span", "embed-facts", facts.join(" · ")));
    const saved = formatDate(snapshot.fetchedAt);
    if (saved) foot.append(el("span", "embed-saved", `Saved ${saved}`));
    const actions = el("span", "embed-actions");
    actions.append(link(snapshot.url, `Open on ${provider}`));
    if (target.frameUrl) {
      const frameUrl = target.frameUrl;
      actions.append(
        button("Show live post", "embed-action", () =>
          this.showLive(block, target, snapshot, frameUrl),
        ),
      );
    }
    if (this.editor.isEditable) {
      actions.append(
        button("Refresh copy", "embed-action embed-refresh", () => this.load(block, target, true)),
      );
    }
    foot.append(actions);
    card.append(foot);
    return card;
  }

  private postText(text: string) {
    const body = el("p", "embed-text");
    if (text.length <= CLAMP_CHARS) {
      body.textContent = text;
      return body;
    }
    body.textContent = `${text.slice(0, CLAMP_CHARS).trimEnd()}…`;
    const wrap = el("div", "embed-text-wrap");
    const more = button("Show more", "embed-action embed-more", () => {
      const open = more.textContent === "Show less";
      body.textContent = open ? `${text.slice(0, CLAMP_CHARS).trimEnd()}…` : text;
      more.textContent = open ? "Show more" : "Show less";
    });
    wrap.append(body, more);
    return wrap;
  }

  /** Nothing loads from the provider until this runs. */
  private showLive(
    block: EmbedBlock,
    target: EmbedTarget,
    snapshot: EmbedSnapshot,
    frameUrl: string,
  ) {
    const provider = PROVIDER_NAMES[target.provider];
    const wrap = el("div", "embed-live");
    const frame = el("iframe", "embed-frame");
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.title = `${provider} post`;
    frame.src = frameUrl;
    const bar = el("div", "embed-foot");
    const actions = el("span", "embed-actions");
    actions.append(
      link(snapshot.url, `Open on ${provider}`),
      button("Show saved copy", "embed-action", () =>
        this.stage.replaceChildren(this.card(block, target, snapshot)),
      ),
    );
    bar.append(actions);
    wrap.append(frame, bar);
    this.stage.replaceChildren(wrap);
  }

  private linkCard(block: EmbedBlock, note: string | null) {
    const href = block.target?.canonicalUrl ?? block.url;
    const card = el("div", "embed-card embed-card-link");
    const provider = block.target ? PROVIDER_NAMES[block.target.provider] : null;
    card.append(el("span", "embed-provider", provider ?? hostOf(href)));
    card.append(link(href, href, "embed-link embed-link-main"));
    if (note) card.append(el("p", "embed-note", note));
    return card;
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
