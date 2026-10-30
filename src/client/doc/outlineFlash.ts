import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const FLASH_MS = 1600;

const flashKey = new PluginKey<DecorationSet>("docsCloudOutlineFlash");

type FlashMeta =
  | { readonly add: ReadonlyArray<number>; readonly id: number }
  | { readonly remove: number };

/**
 * Highlights newly arrived headings once, as node decorations so ProseMirror
 * keeps owning the heading DOM. Registered by the outline at runtime, which
 * keeps it out of the shared extension list.
 */
export function registerOutlineFlash(editor: Editor): () => void {
  editor.registerPlugin(
    new Plugin<DecorationSet>({
      key: flashKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => {
          const mapped = set.map(tr.mapping, tr.doc);
          const meta = tr.getMeta(flashKey) as FlashMeta | undefined;
          if (!meta) return mapped;
          if ("remove" in meta) {
            return mapped.remove(
              mapped.find(undefined, undefined, (spec) => spec.id === meta.remove),
            );
          }
          const decorations = meta.add.flatMap((pos) => {
            const node = tr.doc.nodeAt(pos);
            return node
              ? [
                  Decoration.node(
                    pos,
                    pos + node.nodeSize,
                    { class: "outline-flash" },
                    { id: meta.id },
                  ),
                ]
              : [];
          });
          return mapped.add(tr.doc, decorations);
        },
      },
      props: { decorations: (state) => flashKey.getState(state) },
    }),
  );
  return () => {
    if (!editor.isDestroyed) editor.unregisterPlugin(flashKey);
  };
}

let nextFlashId = 0;

/**
 * Flash the headings at `positions` once. The removal is a no-op if the
 * editor or plugin has gone away by then.
 */
export function flashHeadings(editor: Editor, positions: ReadonlyArray<number>) {
  if (positions.length === 0 || editor.isDestroyed || !flashKey.get(editor.state)) return;
  const id = nextFlashId++;
  editor.view.dispatch(
    editor.state.tr.setMeta(flashKey, { add: positions, id } satisfies FlashMeta),
  );
  setTimeout(() => {
    if (editor.isDestroyed || !flashKey.get(editor.state)) return;
    editor.view.dispatch(editor.state.tr.setMeta(flashKey, { remove: id } satisfies FlashMeta));
  }, FLASH_MS);
}
