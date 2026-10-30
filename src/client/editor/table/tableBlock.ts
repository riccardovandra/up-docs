import type { Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";

import { formatTable, starterTable, TABLE_LANGUAGE } from "../../../shared/table.ts";
import { isTableNode } from "./TableView.ts";

/**
 * A table's text is its JSON, which the node view hides. A caret that lands
 * inside it (arrow keys, undo) selects the whole block instead.
 */
export const tableSelectionPlugin = new Plugin({
  key: new PluginKey("docsCloudTableSelection"),
  appendTransaction: (_, __, state) => {
    const { selection } = state;
    if (selection instanceof NodeSelection) return null;
    const { $from } = selection;
    if (!isTableNode($from.parent)) return null;
    return state.tr.setSelection(NodeSelection.create(state.doc, $from.before()));
  },
});

/** Inserts a new rich table at the selection, for toolbars and menus. */
export function insertRichTable(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .insertContent({
      type: "codeBlock",
      attrs: { language: TABLE_LANGUAGE },
      content: [{ type: "text", text: formatTable(starterTable()) }],
    })
    .run();
}
