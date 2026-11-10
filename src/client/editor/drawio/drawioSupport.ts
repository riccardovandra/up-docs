import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

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
 * Links a diagram at the caret. A line follows the block, so the caret stays
 * out of it and the picture shows.
 *
 * `focus: false` leaves the keyboard where it is: the block of a new diagram
 * goes in while the Draw.io editor is still open over the page, and the keys
 * the person presses next must keep going to their drawing.
 */
export function linkDiagramAtCaret(editor: Editor, diagramId: string, focus: boolean): boolean {
  const chain = focus ? editor.chain().focus() : editor.chain();
  return chain
    .insertContent([drawioNode(diagramId), { type: "paragraph" }])
    .scrollIntoView()
    .run();
}

/** `linkDiagramAtCaret`, unless the editor is gone or read-only: then false, and nothing changes. */
export function insertDrawioBlock(
  editor: Editor,
  diagramId: string,
  options: { readonly focus: boolean } = { focus: true },
): boolean {
  return changeable(editor) && linkDiagramAtCaret(editor, diagramId, options.focus);
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
 * The change that points the block at `pos` at another diagram, keeping its
 * caption; null when no linked diagram is there.
 */
export function relinkBlockStep(
  state: EditorState,
  pos: number,
  diagramId: string,
): Transaction | null {
  const node = blockAt(state.doc, pos);
  if (!node) return null;
  const caption = parseDrawioBlock(node.textContent)?.caption ?? null;
  const from = pos + 1;
  return state.tr.replaceWith(
    from,
    from + node.content.size,
    state.schema.text(drawioBlockBody(diagramId, caption)),
  );
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
