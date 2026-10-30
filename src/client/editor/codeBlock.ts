import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";

import type { DiagramCache, DiagramRender } from "./diagramCache.ts";
import "./diagrams.css";
import { widgetInfo } from "../../shared/widget/fence.ts";
import { WidgetView } from "./widget/WidgetView.ts";
import { tableSelectionPlugin } from "./table/tableBlock.ts";
import { isTableNode, TableView } from "./table/TableView.ts";

let loadedCache: DiagramCache | null = null;
// Imported on demand so the renderer loads with a tab's first diagram. Once it
// has, cached diagrams paint synchronously when a view is recreated.
const loadCache = () =>
  import("./renderDiagram.ts").then(({ diagramCache }) => (loadedCache = diagramCache));

const isMermaid = (node: ProseMirrorNode) => node.attrs.language === "mermaid";
/** ```t3-widget id=… blocks: Claude-style diagrams (see shared/widget/fence.ts). */
const isWidget = (node: ProseMirrorNode) =>
  widgetInfo(node.attrs.language as string | null) !== null;
const isDiagram = (node: ProseMirrorNode) => isMermaid(node) || isWidget(node);

/**
 * A fence that opens and closes `text` safely. CommonMark ends a block at the
 * first line holding a fence at least as long as the opening one.
 */
export function codeFence(text: string, preferred: string | null): string {
  const char = preferred?.startsWith("~") ? "~" : "`";
  let length = Math.max(3, preferred?.length ?? 3);
  const pattern = char === "`" ? /^ {0,3}(`{3,})/gm : /^ {0,3}(~{3,})/gm;
  for (const match of text.matchAll(pattern)) {
    length = Math.max(length, (match[1]?.length ?? 0) + 1);
  }
  return char.repeat(length);
}

/**
 * Code blocks, plus rendered diagrams for ```mermaid blocks. The fence the
 * markdown used is kept, so a ~~~ or ```` block saves the way an agent wrote it.
 */
export const DocsCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fence: { default: null, rendered: false, parseHTML: () => null },
    };
  },

  parseMarkdown: (token, helpers) => {
    const fence = /^(`{3,}|~{3,})/.exec(token.raw ?? "")?.[1] ?? null;
    if (token.raw !== undefined && !fence && token.codeBlockStyle !== "indented") return [];
    return helpers.createNode(
      "codeBlock",
      { language: token.lang || null, fence },
      token.text ? [helpers.createTextNode(token.text)] : [],
    );
  },

  renderMarkdown: (node, helpers) => {
    const language = node.attrs?.language ?? "";
    const text = node.content ? helpers.renderChildren(node.content) : "";
    const fence = codeFence(text, node.attrs?.fence ?? null);
    return [`${fence}${language}`, node.content ? text : "", fence].join("\n");
  },

  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      // Leave the source and show the diagram, with the block selected.
      Escape: ({ editor }) => {
        const { $from } = editor.state.selection;
        if ($from.parent.type.name !== this.name || !isDiagram($from.parent)) return false;
        const pos = $from.before();
        editor.view.dispatch(
          editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)),
        );
        return true;
      },
      // Enter on a selected diagram opens its source.
      Enter: (props) => {
        const { selection } = props.editor.state;
        if (
          selection instanceof NodeSelection &&
          selection.node.type.name === this.name &&
          isDiagram(selection.node)
        ) {
          editSource(props.editor, selection.from, selection.node);
          return true;
        }
        return parent.Enter?.(props) ?? false;
      },
    };
  },

  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), tableSelectionPlugin];
  },

  addNodeView() {
    return (props) => {
      // ```t3-table: a rich table whose JSON is the block's text.
      if (isTableNode(props.node)) return new TableView(props);
      if (isWidget(props.node)) return new WidgetView(props, editSource);
      return isMermaid(props.node) ? new DiagramView(props) : new PlainCodeView(props);
    };
  },
});

function editSource(editor: Editor, pos: number, node: ProseMirrorNode) {
  const end = pos + 1 + node.content.size;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)).scrollIntoView(),
  );
  editor.view.focus();
}

class PlainCodeView implements NodeView {
  readonly dom = document.createElement("pre");
  readonly contentDOM = document.createElement("code");

  constructor({ node }: NodeViewRendererProps) {
    this.dom.append(this.contentDOM);
    this.setLanguage(node);
  }

  update(node: ProseMirrorNode) {
    if (node.type.name !== "codeBlock" || isDiagram(node) || isTableNode(node)) return false;
    this.setLanguage(node);
    return true;
  }

  private setLanguage(node: ProseMirrorNode) {
    const language: unknown = node.attrs.language;
    if (typeof language === "string" && language) {
      this.contentDOM.className = `language-${language}`;
    } else {
      this.contentDOM.removeAttribute("class");
    }
  }
}

/**
 * Shows the rendered diagram. With the caret inside the block (click, the Edit
 * button, or arrowing in), the source appears above a live preview; Escape or
 * blur goes back to the diagram. While a render is loading or has failed, the
 * source shows under the message, so the block is never blank.
 */
class DiagramView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("code");
  private readonly render = document.createElement("div");
  private readonly editButton = document.createElement("button");
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: ProseMirrorNode;
  private source = "";
  private destroyed = false;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;

    this.dom.className = "diagram-block";
    const chrome = document.createElement("div");
    chrome.className = "diagram-chrome";
    chrome.contentEditable = "false";
    this.render.className = "diagram-render";
    this.editButton.type = "button";
    this.editButton.className = "diagram-edit";
    this.editButton.textContent = "Edit";
    chrome.append(this.render, this.editButton);
    const pre = document.createElement("pre");
    pre.className = "diagram-source";
    pre.append(this.contentDOM);
    this.contentDOM.className = "language-mermaid";
    this.dom.append(pre, chrome);

    // Keep the browser from placing a caret in the diagram; the click opens the source.
    chrome.addEventListener("mousedown", (event) => event.preventDefault());
    chrome.addEventListener("click", this.onChromeClick);
    editor.on("selectionUpdate", this.syncEditing);
    editor.on("focus", this.syncEditing);
    editor.on("blur", this.syncEditing);
    this.showSource(node.textContent);
    this.syncEditing();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !isMermaid(node)) return false;
    this.node = node;
    this.showSource(node.textContent);
    this.syncEditing();
    return true;
  }

  // The rendered diagram and the button are ours, not ProseMirror's.
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

  private readonly onChromeClick = () => {
    if (!this.editor.isEditable || this.dom.hasAttribute("data-editing")) return;
    const pos = this.getPos();
    if (typeof pos === "number") editSource(this.editor, pos, this.node);
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

  private showSource(text: string) {
    const source = text.trim();
    if (source === this.source) return;
    this.source = source;
    if (!source) {
      this.paint({ status: "error", message: "Empty diagram. Edit to add mermaid source." });
      return;
    }
    const cached = loadedCache?.peek(source);
    if (cached) {
      this.paint(cached);
      return;
    }
    // A changed source keeps the previous diagram until the new one is ready.
    if (!this.dom.hasAttribute("data-state")) this.dom.dataset.state = "loading";
    void (loadedCache ? Promise.resolve(loadedCache) : loadCache())
      .then((cache) => cache.get(source))
      .then(
        (result) => {
          if (!this.destroyed && this.source === source) this.paint(result);
        },
        () => {
          if (!this.destroyed && this.source === source) {
            this.paint({ status: "error", message: "The diagram renderer failed to load." });
          }
        },
      );
  }

  private paint(result: DiagramRender) {
    this.dom.dataset.state = result.status;
    if (result.status === "rendered") {
      this.render.innerHTML = result.svg;
    } else {
      const message = document.createElement("p");
      message.className = "diagram-error";
      message.textContent = result.message;
      this.render.replaceChildren(message);
    }
  }
}
