// Designs in docs (S4): putting a ```t3-design block into a tab and taking it out.

import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

import { DESIGN_LANGUAGE, designBlockBody, isDesignLanguage } from "../../../shared/designBlock.ts";

/** The node for a block that shows `designId`, as the editor's JSON. */
export const designNode = (designId: string, caption: string | null = null) => ({
  type: "codeBlock",
  attrs: { language: DESIGN_LANGUAGE },
  content: [{ type: "text", text: designBlockBody(designId, caption) }],
});

/** The design block that starts at `pos`, if one does. */
function blockAt(doc: ProseMirrorNode, pos: number): ProseMirrorNode | null {
  const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null;
  return node?.type.name === "codeBlock" && isDesignLanguage(node.attrs.language as string | null)
    ? node
    : null;
}

/**
 * Puts the caret after the block the last step inserted for `designId`, outside
 * it, so its picture shows and not its source. Where nothing follows, or only a
 * code block (whose source the caret would open), an empty line goes in for it.
 */
function caretAfterInserted(tr: Transaction, designId: string): boolean {
  const body = designBlockBody(designId);
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

/** Shows the design at the caret, and leaves the caret after it. `focus: false` leaves the keyboard. */
export function linkDesignAtCaret(editor: Editor, designId: string, focus = true): boolean {
  return (focus ? editor.chain().focus() : editor.chain())
    .insertContent(designNode(designId))
    .command(({ tr }) => caretAfterInserted(tr, designId))
    .scrollIntoView()
    .run();
}

/** `linkDesignAtCaret`, unless the editor is gone or read-only: then false, and nothing changes. */
export const insertDesignBlock = (editor: Editor, designId: string): boolean =>
  !editor.isDestroyed && editor.isEditable && linkDesignAtCaret(editor, designId);

/** The change that takes the block at `pos` out of the tab; null when no design block is there. */
export function removeDesignStep(state: EditorState, pos: number): Transaction | null {
  const node = blockAt(state.doc, pos);
  if (!node) return null;
  const end = pos + node.nodeSize;
  const paragraph = state.schema.nodes.paragraph;
  // A tab cannot be left with no block at all.
  return state.doc.childCount === 1 && paragraph
    ? state.tr.replaceWith(pos, end, paragraph.create())
    : state.tr.delete(pos, end);
}

/** Removes the block at `pos`; the design stays in the library. False when nothing changed. */
export function removeDesignBlock(editor: Editor, pos: number): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const tr = removeDesignStep(editor.state, pos);
  if (!tr) return false;
  editor.view.dispatch(tr);
  return true;
}
