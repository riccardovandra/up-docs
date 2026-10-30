import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DocAnchor, StructuredAnchor } from "../../shared/anchors.ts";
import {
  isTableNode,
  TABLE_COMMENTS_SPEC,
  type CellAnchor,
  type TableCommentSpec,
} from "../editor/table/TableView.ts";
import { widgetInfo } from "../../shared/widget/fence.ts";
import { analyzeWidget } from "../../shared/widget/validate.ts";
import { visiblePos } from "../editor/headingFold.ts";
import { buildDocTextIndex, captureDocAnchor, resolveDocAnchor } from "./editorAnchors.ts";

export interface EditorCommentAnchor extends DocAnchor {
  readonly id: string;
  /** A cell or label anchor; the quote fields are then only a label. */
  readonly structured?: StructuredAnchor | null;
}

interface CommentRange {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

interface PluginState {
  readonly anchors: ReadonlyArray<EditorCommentAnchor>;
  readonly activeId: string | null;
  readonly ranges: ReadonlyArray<CommentRange>;
  readonly cells: ReadonlyArray<CellAnchor & { readonly id: string }>;
  /** Diagram label threads, by the position of their diagram block. */
  readonly labels: ReadonlyArray<{ readonly id: string; readonly pos: number }>;
  readonly decorations: DecorationSet;
}

type TableHandlers = Pick<TableCommentSpec, "onActivate" | "onComment">;

const commentsKey = new PluginKey<PluginState>("docsCloudComments");

// Nodes are immutable, so a diagram is parsed once per version, and only when
// a label thread points into it.
const labelIdsByNode = new WeakMap<ProseMirrorNode, ReadonlySet<string>>();
function labelIds(node: ProseMirrorNode): ReadonlySet<string> {
  let ids = labelIdsByNode.get(node);
  if (!ids) {
    ids = new Set(analyzeWidget(node.textContent).labels.map((label) => label.id));
    labelIdsByNode.set(node, ids);
  }
  return ids;
}

function computeState(
  doc: ProseMirrorNode,
  anchors: ReadonlyArray<EditorCommentAnchor>,
  activeId: string | null,
  tables: TableHandlers,
): PluginState {
  const index = buildDocTextIndex(doc);
  const ranges = anchors.flatMap((anchor) => {
    if (anchor.structured) return [];
    const range = resolveDocAnchor(index, anchor);
    return range ? [{ id: anchor.id, ...range }] : [];
  });
  const cells = anchors.flatMap((anchor) =>
    anchor.structured?.kind === "cell" ? [{ ...anchor.structured, id: anchor.id }] : [],
  );
  const decorations: Array<Decoration> = ranges.map((range) =>
    Decoration.inline(range.from, range.to, {
      class: range.id === activeId ? "comment-mark comment-mark-active" : "comment-mark",
    }),
  );
  // Each table view reads its cell threads from a node decoration, so it
  // repaints highlights without the plugin knowing its DOM.
  const spec: TableCommentSpec = { cells, activeId, ...tables };
  const labelAnchors = anchors.flatMap((anchor) =>
    anchor.structured?.kind === "label" ? [{ id: anchor.id, ...anchor.structured }] : [],
  );
  const labels: Array<{ id: string; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (labelAnchors.length > 0 && node.type.name === "codeBlock") {
      const diagramId = widgetInfo(node.attrs.language as string | null)?.id;
      for (const label of labelAnchors) {
        if (label.blockId === diagramId && labelIds(node).has(label.textId)) {
          labels.push({ id: label.id, pos });
        }
      }
    }
    if (isTableNode(node)) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {}, { [TABLE_COMMENTS_SPEC]: spec }),
      );
    }
    return !node.isTextblock;
  });
  return {
    anchors,
    activeId,
    ranges,
    cells,
    labels,
    decorations: DecorationSet.create(doc, decorations),
  };
}

interface Callbacks {
  readonly onClick: (id: string | null) => void;
  readonly onShortcut: () => void;
  /** Starts a comment on a table cell, with the cell's text as its label. */
  readonly onCellComment: (anchor: CellAnchor, text: string) => void;
}

/** Highlights anchored comments, reports clicks on them, and owns Cmd/Ctrl+Option+M. */
function createCommentsPlugin(callbacks: () => Callbacks, onUpdate: () => void) {
  const tables: TableHandlers = {
    onActivate: (id) => callbacks().onClick(id),
    onComment: (anchor, text) => callbacks().onCellComment(anchor, text),
  };
  return new Plugin<PluginState>({
    key: commentsKey,
    state: {
      init: (_, state) => computeState(state.doc, [], null, tables),
      apply: (tr, value, _, next) => {
        const meta = tr.getMeta(commentsKey) as
          | Pick<PluginState, "anchors" | "activeId">
          | undefined;
        if (meta) return computeState(next.doc, meta.anchors, meta.activeId, tables);
        if (tr.docChanged) return computeState(next.doc, value.anchors, value.activeId, tables);
        return value;
      },
    },
    props: {
      decorations: (state) => commentsKey.getState(state)?.decorations,
      handleClick: (view, pos) => {
        const ranges = commentsKey.getState(view.state)?.ranges ?? [];
        callbacks().onClick(
          ranges.find((range) => pos >= range.from && pos <= range.to)?.id ?? null,
        );
        return false;
      },
      handleKeyDown: (view, event) => {
        // Option+M types a character on macOS, so match the physical key.
        if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.code !== "KeyM") {
          return false;
        }
        if (view.state.selection.empty) return false;
        callbacks().onShortcut();
        return true;
      },
    },
    view: () => {
      onUpdate();
      return { update: onUpdate };
    },
  });
}

/** Captures an anchor for the editor's current selection, or null when nothing is selected. */
export function selectionAnchor(editor: Editor): DocAnchor | null {
  const { from, to, empty } = editor.state.selection;
  return empty ? null : captureDocAnchor(buildDocTextIndex(editor.state.doc), from, to);
}

function showAnchors(editor: Editor, state: Pick<PluginState, "anchors" | "activeId">): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(commentsKey, { anchors: state.anchors, activeId: state.activeId }),
  );
}

const sameTops = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([id, top]) => b.get(id) === top);

/**
 * Wires comment anchors into the live editor. Returns where each anchored
 * comment's passage starts, in pixels from the top of `container`; a comment
 * missing from `tops` has lost its passage.
 */
export function useEditorComments(
  editor: Editor | null,
  props: Callbacks & {
    readonly anchors: ReadonlyArray<EditorCommentAnchor>;
    readonly activeId: string | null;
    readonly container: HTMLElement | null;
  },
): ReadonlyMap<string, number> {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [tops, setTops] = useState<ReadonlyMap<string, number>>(new Map());
  const { container } = props;

  useEffect(() => {
    if (!editor || !container) return;
    const measure = () => {
      if (editor.isDestroyed) return;
      const origin = container.getBoundingClientRect().top;
      // A passage inside a folded section sits beside the heading that hides it.
      const topAt = (pos: number) =>
        Math.round(editor.view.coordsAtPos(visiblePos(editor.state, pos)).top - origin);
      const topOf = (element: Element, pos: number) => {
        const shown = visiblePos(editor.state, pos);
        return shown === pos
          ? Math.round(element.getBoundingClientRect().top - origin)
          : topAt(shown);
      };
      const next = new Map<string, number>();
      const state = commentsKey.getState(editor.state);
      for (const range of state?.ranges ?? []) {
        next.set(range.id, topAt(range.from));
      }
      // A cell missing from the DOM has had its row or column deleted.
      for (const cell of state?.cells ?? []) {
        const element = editor.view.dom.querySelector(
          `table[data-table-id="${CSS.escape(cell.blockId)}"] td[data-row-id="${CSS.escape(cell.rowId)}"][data-col-id="${CSS.escape(cell.colId)}"]`,
        );
        if (element) next.set(cell.id, topOf(element, editor.view.posAtDOM(element, 0)));
      }
      // The diagram draws in a sandboxed frame, so a label thread sits beside its diagram.
      for (const label of state?.labels ?? []) {
        const element = editor.view.nodeDOM(label.pos);
        if (element instanceof HTMLElement) next.set(label.id, topOf(element, label.pos));
      }
      setTops((current) => (sameTops(current, next) ? current : next));
    };
    // Measuring reads layout, so it runs after the view has updated the DOM.
    const schedule = () => queueMicrotask(measure);
    editor.registerPlugin(createCommentsPlugin(() => latest.current, schedule));
    showAnchors(editor, latest.current);
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (!editor.isDestroyed) editor.unregisterPlugin(commentsKey);
      setTops(new Map());
    };
  }, [editor, container]);

  const { anchors, activeId } = props;
  useEffect(() => {
    if (editor && !editor.isDestroyed) showAnchors(editor, { anchors, activeId });
  }, [editor, anchors, activeId]);

  return tops;
}
