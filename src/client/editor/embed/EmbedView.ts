import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import {
  type EmbedBlock,
  embedInfoString,
  embedOptions,
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
 * The provider's own embed page. Its scripts run in the provider's origin,
 * never ours; it cannot navigate the doc, submit forms or open dialogs.
 * Popups (its own links) open in a new tab.
 */
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** The sizes the providers' own embed snippets use. */
const FRAME_SIZE = {
  linkedin: { width: 504, height: 670 },
  x: { width: 550, height: 420 },
} as const;
const X_ORIGIN = "https://platform.twitter.com";
const MAX_FRAME_HEIGHT = 4000;

/** Characters of post text the saved copy shows before "Show more". */
const CLAMP_CHARS = 600;

type Mode = "live" | "saved";

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

const isDark = () => getComputedStyle(document.documentElement).colorScheme === "dark";

/** The height X's post embed asks for, from its `twttr.private.resize` message (an object, or JSON text). */
export function xFrameHeight(data: unknown): number | null {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const message = (value as { "twttr.embed"?: { method?: unknown; params?: unknown } })[
    "twttr.embed"
  ];
  if (message?.method !== "twttr.private.resize" || !Array.isArray(message.params)) return null;
  const height = (message.params[0] as { height?: unknown } | undefined)?.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? Math.min(Math.ceil(height), MAX_FRAME_HEIGHT)
    : null;
}

/**
 * A ```t3-embed block. A LinkedIn or X post shows the provider's own embed,
 * with the doc's saved copy (plain text, image from the doc's own images) a
 * click away and in its place when the post cannot be loaded. ```t3-embed
 * compact shows the author and two lines from the saved copy, and contacts the
 * provider only when a reader expands it. Any other link shows a link card.
 * "Edit" (or the caret entering the block) shows the source.
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
  /** Source and info string last shown; a change to either rebuilds the block. */
  private shown: string | null = null;
  /** Bumped on every rebuild, so a late response for an old link is dropped. */
  private generation = 0;
  private destroyed = false;
  private frame: HTMLIFrameElement | null = null;

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
    window.addEventListener("message", this.onMessage);
    this.show();
    this.syncEditing();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !isEmbedLanguage(node.attrs.language as string | null)) {
      return false;
    }
    this.node = node;
    this.show();
    this.syncEditing();
    return true;
  }

  // The card, its buttons and the frame are ours, not ProseMirror's.
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
    window.removeEventListener("message", this.onMessage);
  }

  private get support(): EmbedSupportStorage | undefined {
    return (this.editor.storage as { embedSupport?: EmbedSupportStorage }).embedSupport;
  }

  private get compact(): boolean {
    return embedOptions(this.node.attrs.language as string | null).compact;
  }

  /** Rebuilds only when the text or options change, so a loaded embed survives other edits. */
  private show() {
    const source = this.node.textContent;
    const key = `${String(this.node.attrs.language)}\n${source}`;
    if (key === this.shown) return;
    this.shown = key;
    this.generation += 1;
    this.frame = null;
    const block = parseEmbedBlock(source);
    this.caption.replaceChildren();
    this.print.replaceChildren();
    this.dom.toggleAttribute("data-compact", this.compact);
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
    const { target } = block;
    if (!target) {
      this.dom.dataset.state = "link";
      this.stage.replaceChildren(this.linkCard(block, null));
      return;
    }
    if (this.compact) {
      this.showCompact(block, target);
      return;
    }
    if (target.frameUrl) {
      this.showLive(block, target, target.frameUrl);
      // Taken in the background, so the doc keeps the post if it is deleted later.
      void this.copy(block, target, false).catch(() => undefined);
      return;
    }
    this.showSaved(block, target, false);
  }

  /** The doc's saved copy, shared by every view of the same post in this editor. */
  private copy(block: EmbedBlock, target: EmbedTarget, refresh: boolean): Promise<EmbedSnapshot> {
    const support = this.support;
    if (!support?.load) return Promise.reject(new Error("no saved copies here"));
    const key = target.canonicalUrl;
    const previous = support.cache.get(key);
    if (previous && !refresh) return previous;
    const pending = support.load(block.url, refresh);
    support.cache.set(key, pending);
    pending.catch(() => {
      if (support.cache.get(key) !== pending) return;
      // A failed refresh keeps the copy the doc already has; any other failure is retried next time.
      if (refresh && previous) support.cache.set(key, previous);
      else support.cache.delete(key);
    });
    return pending;
  }

  /** Runs `paint` with the saved copy unless the block has been rebuilt since. */
  private withCopy(
    block: EmbedBlock,
    target: EmbedTarget,
    refresh: boolean,
    paint: (snapshot: EmbedSnapshot) => void,
    failed: () => void,
  ) {
    const generation = this.generation;
    this.copy(block, target, refresh).then(
      (snapshot) => {
        if (!this.destroyed && generation === this.generation) paint(snapshot);
      },
      () => {
        if (!this.destroyed && generation === this.generation) failed();
      },
    );
  }

  private showLive(block: EmbedBlock, target: EmbedTarget, frameUrl: string) {
    this.dom.dataset.state = "live";
    const provider = PROVIDER_NAMES[target.provider];
    const size = FRAME_SIZE[target.provider];
    const wrap = el("div", "embed-live");
    wrap.style.maxWidth = `${size.width}px`;
    const frame = el("iframe", "embed-frame");
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.loading = "lazy";
    frame.title = `${provider} post`;
    frame.style.height = `${size.height}px`;
    frame.src = target.provider === "x" && isDark() ? `${frameUrl}&theme=dark` : frameUrl;
    this.frame = frame;
    wrap.append(frame, this.bar(block, target, "live"));
    this.stage.replaceChildren(wrap);
  }

  private showSaved(block: EmbedBlock, target: EmbedTarget, refresh: boolean) {
    if (!this.support?.load) {
      this.dom.dataset.state = "link";
      this.stage.replaceChildren(this.linkCard(block, null));
      return;
    }
    const current = this.stage.firstElementChild;
    this.dom.dataset.state = "loading";
    if (!refresh || !current) this.stage.replaceChildren(this.skeleton(target));
    this.withCopy(
      block,
      target,
      refresh,
      (snapshot) => {
        this.dom.dataset.state = "saved";
        this.stage.replaceChildren(this.card(block, target, snapshot));
      },
      () => {
        if (refresh) {
          // The old copy is back in the cache; show it with a note.
          this.withCopy(
            block,
            target,
            false,
            (snapshot) => {
              this.dom.dataset.state = "saved";
              const card = this.card(block, target, snapshot);
              card.append(
                el("p", "embed-note", "Could not refresh the copy. The saved one is shown."),
              );
              this.stage.replaceChildren(card);
            },
            () => this.showUnavailable(block),
          );
          return;
        }
        this.showUnavailable(block);
      },
    );
  }

  private showUnavailable(block: EmbedBlock) {
    this.dom.dataset.state = "link";
    this.stage.replaceChildren(
      this.linkCard(block, "The post could not be loaded. It may be private or deleted."),
    );
  }

  /** Author and two lines, no image. Nothing reaches the provider until "Show post". */
  private showCompact(block: EmbedBlock, target: EmbedTarget) {
    const expand = () =>
      target.frameUrl
        ? this.showLive(block, target, target.frameUrl)
        : this.showSaved(block, target, false);
    if (!this.support?.load) {
      // No saved copies here (project files): a link card that can still open the post.
      this.dom.dataset.state = "compact";
      const card = this.linkCard(block, null);
      if (target.frameUrl) card.append(this.actions([button("Show post", "embed-action", expand)]));
      this.stage.replaceChildren(card);
      return;
    }
    this.dom.dataset.state = "loading";
    this.stage.replaceChildren(this.skeleton(target));
    this.withCopy(
      block,
      target,
      false,
      (snapshot) => {
        this.dom.dataset.state = "compact";
        const card = el("article", "embed-card embed-card-compact");
        card.dataset.provider = target.provider;
        card.append(this.head(target, snapshot));
        // Blank lines would spend the two lines on nothing.
        const text = (snapshot.text ?? snapshot.title)?.replace(/\n\s*\n+/g, "\n");
        if (text) card.append(el("p", "embed-text embed-text-clamp", text));
        const actions: Array<HTMLElement> = [button("Show post", "embed-action", expand)];
        actions.push(link(snapshot.url, `Open on ${PROVIDER_NAMES[target.provider]}`));
        if (this.editor.isEditable) actions.push(this.compactToggle());
        card.append(this.actions(actions));
        this.stage.replaceChildren(card);
      },
      () => {
        this.dom.dataset.state = "compact";
        const card = this.linkCard(block, null);
        if (target.frameUrl)
          card.append(this.actions([button("Show post", "embed-action", expand)]));
        this.stage.replaceChildren(card);
      },
    );
  }

  /** Links and switches under a live embed or a saved copy. */
  private bar(block: EmbedBlock, target: EmbedTarget, mode: Mode) {
    const provider = PROVIDER_NAMES[target.provider];
    const items: Array<HTMLElement> = [link(target.canonicalUrl, `Open on ${provider}`)];
    if (target.frameUrl && this.support?.load) {
      items.push(
        mode === "live"
          ? button("Saved copy", "embed-action", () => this.showSaved(block, target, false))
          : button("Live post", "embed-action", () =>
              this.showLive(block, target, target.frameUrl!),
            ),
      );
    }
    if (this.editor.isEditable) {
      if (mode === "saved") {
        items.push(
          button("Refresh copy", "embed-action", () => this.showSaved(block, target, true)),
        );
      }
      items.push(this.compactToggle());
    }
    const bar = el("div", "embed-bar");
    bar.append(this.actions(items));
    return bar;
  }

  private actions(items: ReadonlyArray<HTMLElement>) {
    const actions = el("span", "embed-actions");
    actions.append(...items);
    return actions;
  }

  /** Editors switch the block between full and compact; the choice is saved in its info string. */
  private compactToggle() {
    const compact = this.compact;
    return button(compact ? "Full size" : "Compact", "embed-action", () => {
      const pos = this.getPos();
      if (!this.editor.isEditable || typeof pos !== "number") return;
      const node = this.editor.state.doc.nodeAt(pos);
      if (!node || node.type !== this.node.type) return;
      this.editor.view.dispatch(
        this.editor.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          language: embedInfoString(!compact),
        }),
      );
    });
  }

  private skeleton(target: EmbedTarget) {
    const card = el("div", "embed-card embed-card-loading");
    card.setAttribute("aria-busy", "true");
    card.append(el("span", "embed-provider", `Loading ${PROVIDER_NAMES[target.provider]} post…`));
    return card;
  }

  private head(target: EmbedTarget, snapshot: EmbedSnapshot) {
    const head = el("header", "embed-head");
    const who = el("div", "embed-who");
    if (snapshot.author) who.append(el("span", "embed-author", snapshot.author));
    if (snapshot.handle) who.append(el("span", "embed-handle", `@${snapshot.handle}`));
    head.append(who, el("span", "embed-provider", PROVIDER_NAMES[target.provider]));
    return head;
  }

  /** The full saved copy. */
  private card(block: EmbedBlock, target: EmbedTarget, snapshot: EmbedSnapshot) {
    const provider = PROVIDER_NAMES[target.provider];
    const card = el("article", "embed-card");
    card.dataset.provider = target.provider;
    card.append(this.head(target, snapshot));

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
    card.append(foot, this.bar(block, target, "saved"));
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

  private linkCard(block: EmbedBlock, note: string | null) {
    const href = block.target?.canonicalUrl ?? block.url;
    const card = el("div", "embed-card embed-card-link");
    const provider = block.target ? PROVIDER_NAMES[block.target.provider] : null;
    card.append(el("span", "embed-provider", provider ?? hostOf(href)));
    card.append(link(href, href, "embed-link embed-link-main"));
    if (note) card.append(el("p", "embed-note", note));
    return card;
  }

  /** X's post embed reports its height; nothing else from a frame is read. */
  private readonly onMessage = (event: MessageEvent) => {
    const frame = this.frame;
    if (!frame || event.origin !== X_ORIGIN || event.source !== frame.contentWindow) return;
    const height = xFrameHeight(event.data);
    if (height !== null) frame.style.height = `${height}px`;
  };

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
