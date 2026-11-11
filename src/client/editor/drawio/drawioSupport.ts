import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

import { drawioBlockBody, isDrawioLanguage, parseDrawioBlock } from "../../../shared/drawio.ts";
import { type BlockDiagram, drawioNode } from "./blockLogic.ts";

/** What a doc page gives the linked-diagram blocks in its tabs. */
export interface DrawioContext {
  /** The doc the tab is in. */
  readonly docId: string;
  /** The doc's project (null: none), where Detach a copy files the new diagram. */
  readonly projectId: string | null;
  /** Opens the Draw.io editor over the page. The page owns it, so an edit outlives the block. */
  readonly edit: (diagramId: string) => void;
  /** Says something to the person in the page's notice line. */
  readonly notify: (message: string) => void;
}

export interface DrawioSupportOptions {
  /**
   * Read each time it is needed, since a doc can be moved to another project.
   * Null where there is no doc page (project files): blocks then show the
   * picture and offer no Edit or Detach a copy.
   */
  readonly context: () => DrawioContext | null;
}

export interface DrawioSupportStorage {
  readonly context: () => DrawioContext | null;
  /** Each diagram as last seen in this editor, so a recreated block paints at once. */
  readonly known: Map<string, BlockDiagram>;
}

declare module "@tiptap/core" {
  interface Storage {
    drawioSupport: DrawioSupportStorage;
  }
}

/** Holds what ```t3-drawio blocks read from the page around the editor. */
export const DrawioSupport = Extension.create<DrawioSupportOptions, DrawioSupportStorage>({
  name: "drawioSupport",

  addOptions: () => ({ context: () => null }),

  addStorage() {
    return { context: this.options.context, known: new Map() };
  },
});

/** Whether the tab can still be changed: its editor is on the page and the person may edit. */
const changeable = (editor: Editor) => !editor.isDestroyed && editor.isEditable;

/**
 * Puts the caret after the block the last step inserted for `diagramId`, outside
 * it, so its picture shows and not its source. Where text already follows, the
 * caret goes there and nothing is added. Where nothing follows, or only a code
 * block (whose own source the caret would open), one empty line goes in for it.
 */
function caretAfterInserted(tr: Transaction, diagramId: string, page: string | null): boolean {
  const body = drawioBlockBody(diagramId, null, page);
  let end = -1;
  tr.mapping.maps.at(-1)?.forEach((_from, _to, newFrom, newTo) => {
    tr.doc.nodesBetween(newFrom, newTo, (node, pos) => {
      if (end === -1 && pos >= newFrom && blockAt(tr.doc, pos) && node.textContent === body) {
        end = pos + node.nodeSize;
      }
      return end === -1;
    });
  });
  if (end === -1) return false;
  const next = Selection.findFrom(tr.doc.resolve(end), 1, true);
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (next && !next.$from.parent.type.spec.code) tr.setSelection(next);
  else if (paragraph) {
    tr.insert(end, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, end + 1));
  }
  return true;
}

/**
 * Links a diagram at the caret, and leaves the caret after the block: see
 * `caretAfterInserted` for when a line is added under it.
 *
 * `focus: false` leaves the keyboard where it is: the block of a new diagram
 * goes in while the Draw.io editor is still open over the page, and the keys
 * the person presses next must keep going to their drawing.
 */
export function linkDiagramAtCaret(
  editor: Editor,
  diagramId: string,
  focus: boolean,
  page: string | null = null,
): boolean {
  const chain = focus ? editor.chain().focus() : editor.chain();
  return chain
    .insertContent(drawioNode(diagramId, null, page))
    .command(({ tr }) => caretAfterInserted(tr, diagramId, page))
    .scrollIntoView()
    .run();
}

/** `linkDiagramAtCaret`, unless the editor is gone or read-only: then false, and nothing changes. */
export function insertDrawioBlock(
  editor: Editor,
  diagramId: string,
  options: { readonly focus: boolean; readonly page?: string | null } = { focus: true },
): boolean {
  return (
    changeable(editor) &&
    linkDiagramAtCaret(editor, diagramId, options.focus, options.page ?? null)
  );
}

/** The linked-diagram block that starts at `pos`, if one does. */
function blockAt(doc: ProseMirrorNode, pos: number): ProseMirrorNode | null {
  const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null;
  return node?.type.name === "codeBlock" && isDrawioLanguage(node.attrs.language as string | null)
    ? node
    : null;
}

/**
 * The change that takes the block at `pos` out of the tab; null when no linked
 * diagram is there. The diagram itself stays in the library.
 */
export function removeBlockStep(state: EditorState, pos: number): Transaction | null {
  const node = blockAt(state.doc, pos);
  if (!node) return null;
  const end = pos + node.nodeSize;
  const paragraph = state.schema.nodes.paragraph;
  // A tab cannot be left with no block at all.
  return state.doc.childCount === 1 && paragraph
    ? state.tr.replaceWith(pos, end, paragraph.create())
    : state.tr.delete(pos, end);
}

/**
 * The change that points the block at `pos` at another diagram, or at another
 * page of it (null: the first), keeping its caption; null when no linked
 * diagram is there. The page is kept unless one is given: a copy has the same pages.
 */
export function relinkBlockStep(
  state: EditorState,
  pos: number,
  diagramId: string,
  page?: string | null,
): Transaction | null {
  const node = blockAt(state.doc, pos);
  if (!node) return null;
  const block = parseDrawioBlock(node.textContent);
  const body = drawioBlockBody(
    diagramId,
    block?.caption ?? null,
    page === undefined ? (block?.page ?? null) : page,
  );
  if (body === node.textContent) return null;
  const from = pos + 1;
  return state.tr.replaceWith(from, from + node.content.size, state.schema.text(body));
}

const apply = (editor: Editor, tr: Transaction | null): boolean => {
  if (!tr) return false;
  editor.view.dispatch(tr);
  return true;
};

/** Removes the block at `pos`. False when the tab cannot be changed or the block is gone. */
export const removeDrawioBlock = (editor: Editor, pos: number): boolean =>
  changeable(editor) && apply(editor, removeBlockStep(editor.state, pos));

/** Relinks the block at `pos`. False when the tab cannot be changed or the block is gone. */
export const relinkDrawioBlock = (editor: Editor, pos: number, diagramId: string): boolean =>
  changeable(editor) && apply(editor, relinkBlockStep(editor.state, pos, diagramId));

/** The change that points the block at `pos` at another page of its diagram; null when none. */
export function pageBlockStep(
  state: EditorState,
  pos: number,
  page: string | null,
): Transaction | null {
  const block = blockAt(state.doc, pos);
  const diagramId = block ? parseDrawioBlock(block.textContent)?.diagramId : undefined;
  return diagramId === undefined ? null : relinkBlockStep(state, pos, diagramId, page);
}

/**
 * Points the block at `pos` at another page of its diagram. False when the tab
 * cannot be changed, the block is gone, or it already shows that page.
 */
export const setDrawioBlockPage = (editor: Editor, pos: number, page: string | null): boolean =>
  changeable(editor) && apply(editor, pageBlockStep(editor.state, pos, page));
