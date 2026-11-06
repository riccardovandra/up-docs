import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { sameDocTabId } from "../docLinks.ts";

/** Marks the text of a link to another tab of this doc; the doc page reads it for previews. */
export const TAB_LINK_ATTRIBUTE = "data-tab-link";

function tabLinkDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  if (typeof window === "undefined") return DecorationSet.empty;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((mark) => mark.type.name === "link");
    const tabId = link ? sameDocTabId(String(link.attrs.href ?? ""), window.location) : null;
    if (tabId === null) return;
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: "tab-link",
        [TAB_LINK_ATTRIBUTE]: tabId,
      }),
    );
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Shows links to other tabs of the same doc as tab chips. Decorations only:
 * the markdown keeps a plain link, so agents and exports see no change.
 */
export const TabLinks = Extension.create({
  name: "tabLinks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tabLinks"),
        state: {
          init: (_config, state) => tabLinkDecorations(state.doc),
          apply: (tr, current) => (tr.docChanged ? tabLinkDecorations(tr.doc) : current),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
