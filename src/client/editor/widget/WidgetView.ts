import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import { widgetInfo } from "../../../shared/widget/fence.ts";
import type { PreparedWidget } from "./engine.ts";
import { readFrameMessage, WIDGET_SRCDOC, type FrameMessage, type WidgetPick } from "./frame.ts";
import "./widget.css";

type Engine = typeof import("./engine.ts");

let engine: Engine | null = null;
let engineLoad: Promise<Engine> | null = null;
function loadEngine(): Promise<Engine> {
  engineLoad ??= import("./engine.ts").then(
    (loaded) => (engine = loaded),
    (error: unknown) => {
      engineLoad = null;
      throw error;
    },
  );
  return engineLoad;
}

/**
 * The comments seam: every click on a diagram dispatches this from the block
 * with the label's text id and the part's anchor, either may be null.
 */
export const WIDGET_PICK_EVENT = "docs-widget-pick";
export interface WidgetPickDetail {
  readonly diagramId: string;
  readonly textId: string | null;
  readonly anchor: string | null;
}

const COLOUR_TOKENS = [
  "--cds-text-primary",
  "--cds-text-secondary",
  "--cds-chart-axis",
  "--cds-chart-grid",
  "--cds-chart-reference-tint",
  ...Array.from({ length: 8 }, (_, index) => `--cds-chart-categorical-${index + 1}`),
  "--cds-chart-status-good",
  "--cds-chart-status-warning",
  "--cds-chart-status-critical",
];

const views = new Map<Window, WidgetView>();
const live = new Set<WidgetView>();
let watching = false;

function onFrameMessage(event: MessageEvent) {
  if (!event.source) return;
  const view = views.get(event.source as Window);
  const message = readFrameMessage(event.data);
  if (view && message) view.receive(message);
}

/**
 * Theme changes (T3's data-theme, the palette style theme.ts writes, the
 * system scheme) re-post resolved colours; the diagram is never re-run.
 */
function watchTheme() {
  if (watching) return;
  watching = true;
  window.addEventListener("message", onFrameMessage);
  const repost = () => {
    for (const view of live) view.postTheme();
  };
  new MutationObserver(repost).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  new MutationObserver(repost).observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repost);
}

const observer =
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) pending.get(entry.target)?.mount();
          }
        },
        { rootMargin: "600px 0px" },
      );
const pending = new Map<Element, WidgetView>();

/** Mounts every diagram and waits (briefly) for each to draw, for printing. */
export function readyWidgetsForPrint(timeoutMs = 2000): Promise<void> {
  const views = [...pending.values()];
  for (const view of views) view.mount();
  const all = [...live].map((view) => view.drawn);
  return Promise.race([
    Promise.all(all).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeprint", () => void readyWidgetsForPrint());
}

/** The viewBox's aspect ratio, read without the parser so the frame never jumps. */
function aspectRatio(source: string): string {
  const match = /viewBox\s*=\s*\{?\s*['"`]\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/.exec(
    source,
  );
  return match ? `${match[1]} / ${match[2]}` : "760 / 280";
}

/**
 * A ```t3-widget diagram. It renders in a sandboxed frame once it nears the
 * viewport. Clicking a label opens an edit box over it; Enter or blur writes
 * the new words into the module (only that label's text changes), Escape
 * cancels. "Edit code" (or the caret entering the block) shows the source.
 */
export class WidgetView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("code");
  private readonly stage = document.createElement("div");
  private readonly input = document.createElement("input");
  private readonly diagnostics = document.createElement("ul");
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private readonly openSource: (editor: Editor, pos: number, node: ProseMirrorNode) => void;
  private node: ProseMirrorNode;
  private source = "";
  private prepared: PreparedWidget | null = null;
  private frame: HTMLIFrameElement | null = null;
  private frameReady = false;
  private nonce = 0;
  private renderedNonce = -1;
  private lastTheme = "";
  private editing: { readonly textId: string; readonly original: string } | null = null;
  private destroyed = false;
  private resolveDrawn: (() => void) | null = null;
  drawn: Promise<void>;

  constructor(
    { node, editor, getPos }: NodeViewRendererProps,
    openSource: (editor: Editor, pos: number, node: ProseMirrorNode) => void,
  ) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.openSource = openSource;
    this.drawn = new Promise((resolve) => (this.resolveDrawn = resolve));

    this.dom.className = "widget-block";
    const pre = document.createElement("pre");
    pre.className = "widget-source";
    pre.append(this.contentDOM);
    const chrome = document.createElement("div");
    chrome.className = "widget-chrome";
    chrome.contentEditable = "false";
    this.stage.className = "widget-stage";
    this.input.className = "widget-label-input";
    this.input.type = "text";
    this.input.hidden = true;
    this.stage.append(this.input);
    this.diagnostics.className = "widget-diagnostics";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "widget-edit";
    editButton.textContent = "Edit code";
    editButton.addEventListener("mousedown", (event) => event.preventDefault());
    editButton.addEventListener("click", () => {
      const pos = this.getPos();
      if (this.editor.isEditable && typeof pos === "number")
        this.openSource(this.editor, pos, this.node);
    });
    chrome.append(this.stage, this.diagnostics, editButton);
    this.dom.append(pre, chrome);

    this.input.addEventListener("keydown", this.onInputKey);
    this.input.addEventListener("blur", () => this.finishLabelEdit(true));
    editor.on("selectionUpdate", this.syncEditing);
    editor.on("focus", this.syncEditing);
    editor.on("blur", this.syncEditing);

    watchTheme();
    live.add(this);
    pending.set(this.dom, this);
    observer?.observe(this.dom);
    if (!observer) this.mount();
    this.showSource(node.textContent);
    this.syncEditing();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !widgetInfo(node.attrs.language as string | null))
      return false;
    this.node = node;
    this.showSource(node.textContent);
    this.syncEditing();
    return true;
  }

  stopEvent(event: Event) {
    return event.target instanceof Node && !this.contentDOM.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target);
  }

  destroy() {
    this.destroyed = true;
    live.delete(this);
    pending.delete(this.dom);
    observer?.unobserve(this.dom);
    if (this.frame?.contentWindow) views.delete(this.frame.contentWindow);
    this.editor.off("selectionUpdate", this.syncEditing);
    this.editor.off("focus", this.syncEditing);
    this.editor.off("blur", this.syncEditing);
    this.resolveDrawn?.();
  }

  private get diagramId(): string {
    return widgetInfo(this.node.attrs.language as string | null)?.id ?? "";
  }

  /** Creates the frame; diagrams far from the viewport wait for this. */
  mount() {
    if (this.frame || this.destroyed) return;
    pending.delete(this.dom);
    observer?.unobserve(this.dom);
    const frame = document.createElement("iframe");
    frame.className = "widget-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("scrolling", "no");
    frame.title = "Diagram";
    frame.srcdoc = WIDGET_SRCDOC;
    this.frame = frame;
    this.stage.prepend(frame);
    if (frame.contentWindow) views.set(frame.contentWindow, this);
  }

  receive(message: FrameMessage) {
    switch (message.type) {
      case "ready":
        this.frameReady = true;
        this.lastTheme = "";
        this.postTheme();
        this.postRender();
        break;
      case "rendered":
        if (message.nonce !== this.nonce) break;
        this.renderedNonce = message.nonce;
        this.dom.dataset.state = this.prepared?.analysis.diagnostics.length
          ? "invalid"
          : "rendered";
        this.resolveDrawn?.();
        break;
      case "error":
        if (message.nonce !== this.nonce) break;
        this.dom.dataset.state = "error";
        this.showProblems([`The diagram failed to run: ${message.message}`]);
        this.resolveDrawn?.();
        break;
      case "pick":
        this.onPick(message);
        break;
    }
  }

  postTheme() {
    if (!this.frameReady || !this.frame?.contentWindow) return;
    const style = getComputedStyle(this.dom);
    const vars: Record<string, string> = {};
    for (const token of COLOUR_TOKENS) vars[token] = style.getPropertyValue(token).trim();
    vars["--widget-font"] = style.getPropertyValue("--font-sans").trim();
    const serialized = JSON.stringify(vars);
    if (serialized === this.lastTheme) return;
    this.lastTheme = serialized;
    this.frame.contentWindow.postMessage({ type: "theme", vars }, "*");
  }

  private postRender() {
    const code = this.prepared?.code;
    if (!this.frameReady || !this.frame?.contentWindow || !code) return;
    this.nonce += 1;
    this.frame.contentWindow.postMessage(
      { type: "render", nonce: this.nonce, code, editable: this.editor.isEditable },
      "*",
    );
  }

  private showSource(text: string) {
    if (text === this.source) return;
    this.source = text;
    this.stage.style.aspectRatio = aspectRatio(text);
    if (!this.dom.dataset.state) this.dom.dataset.state = "loading";
    if (this.editing) this.finishLabelEdit(false);
    if (engine) {
      this.apply(engine.prepareWidget(text));
      return;
    }
    void loadEngine().then(
      (loaded) => {
        if (!this.destroyed && this.source === text) this.apply(loaded.prepareWidget(text));
      },
      () => {
        if (this.destroyed) return;
        this.dom.dataset.state = "error";
        this.showProblems(["The diagram renderer failed to load."]);
      },
    );
  }

  private apply(prepared: PreparedWidget) {
    this.prepared = prepared;
    const problems = prepared.analysis.diagnostics.map((entry) => engine!.formatDiagnostic(entry));
    this.showProblems(problems);
    if (!prepared.code) {
      this.dom.dataset.state = "error";
      this.resolveDrawn?.();
      return;
    }
    if (this.renderedNonce >= 0 && problems.length === 0) this.dom.dataset.state = "rendered";
    this.postRender();
  }

  private showProblems(lines: ReadonlyArray<string>) {
    this.diagnostics.replaceChildren(
      ...lines.map((line) => {
        const item = document.createElement("li");
        item.textContent = line;
        return item;
      }),
    );
  }

  private onPick(pick: WidgetPick) {
    const detail: WidgetPickDetail = {
      diagramId: this.diagramId,
      textId: pick.textId,
      anchor: pick.anchor,
    };
    this.dom.dispatchEvent(new CustomEvent(WIDGET_PICK_EVENT, { bubbles: true, detail }));
    if (!this.editor.isEditable || !pick.textId || !pick.rect) return;
    const label = this.prepared?.analysis.labels.find((entry) => entry.id === pick.textId);
    if (!label) return;
    this.startLabelEdit(label.id, label.text, pick);
  }

  private startLabelEdit(textId: string, text: string, pick: WidgetPick) {
    const rect = pick.rect!;
    this.editing = { textId, original: text };
    const fontSize = Math.max(pick.fontSize, 11);
    const width = Math.max(rect.width + fontSize * 3, 96);
    const centre = rect.x + rect.width / 2;
    const left =
      pick.textAnchor === "middle"
        ? centre - width / 2
        : pick.textAnchor === "end"
          ? rect.x + rect.width - width
          : rect.x - 4;
    const stageWidth = this.stage.clientWidth;
    Object.assign(this.input.style, {
      left: `${Math.max(0, Math.min(left, stageWidth - width))}px`,
      top: `${rect.y + rect.height / 2}px`,
      width: `${Math.min(width, stageWidth)}px`,
      fontSize: `${fontSize}px`,
      fontWeight: pick.fontWeight,
      textAlign:
        pick.textAnchor === "middle" ? "center" : pick.textAnchor === "end" ? "right" : "left",
    });
    this.input.value = text;
    this.input.hidden = false;
    this.frame?.contentWindow?.postMessage({ type: "hide", textId }, "*");
    this.input.focus();
    this.input.select();
  }

  private readonly onInputKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      this.finishLabelEdit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.finishLabelEdit(false);
    }
  };

  private finishLabelEdit(commit: boolean) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    this.input.hidden = true;
    this.frame?.contentWindow?.postMessage({ type: "hide", textId: null }, "*");
    if (!commit || !engine) return;
    const result = engine.rewriteLabel(this.source, editing.textId, this.input.value);
    if (!result.ok || !result.replacement) return;
    const pos = this.getPos();
    if (typeof pos !== "number") return;
    const { start, end, text } = result.replacement;
    // Code block text maps one to one onto source offsets, so only the label's
    // characters are replaced and the save goes through the normal editor path.
    const from = pos + 1 + start;
    this.editor.view.dispatch(this.editor.state.tr.insertText(text, from, pos + 1 + end));
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
