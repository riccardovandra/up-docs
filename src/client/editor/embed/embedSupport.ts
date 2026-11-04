import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { type EditorState, Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";

import { EMBED_LANGUAGE, type EmbedSnapshot, matchEmbed } from "../../../shared/embeds.ts";

/**
 * Fetches the doc's saved copy of a post; `refresh` retakes it. Rejects when
 * there is none to be had, and the block shows a link card instead.
 */
export type EmbedLoader = (url: string, refresh: boolean) => Promise<EmbedSnapshot>;

export interface EmbedSupportOptions {
  /** Null for docs with no saved copies, such as project files: blocks show link cards. */
  readonly load: EmbedLoader | null;
}

export interface EmbedSupportStorage {
  readonly load: EmbedLoader | null;
  /** One request per post per editor, so recreated views and repeated links share it. */
  readonly cache: Map<string, Promise<EmbedSnapshot>>;
}

declare module "@tiptap/core" {
  interface Storage {
    embedSupport: EmbedSupportStorage;
  }
}

/**
 * Holds the loader embed blocks read from, and turns a LinkedIn or X link
 * pasted on an empty line into an embed. Undo right after brings back the
 * plain link.
 */
export const EmbedSupport = Extension.create<EmbedSupportOptions, EmbedSupportStorage>({
  name: "embedSupport",

  addOptions: () => ({ load: null }),

  addStorage() {
    return { load: this.options.load, cache: new Map() };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            if (!view.editable) return false;
            const pasted = event.clipboardData?.getData("text/plain") ?? "";
            return pasteEmbed(view, pasted);
          },
        },
      }),
    ];
  },
});

/**
 * Pastes a lone LinkedIn or X link on an empty top-level line as two steps:
 * the plain link, then the embed in its own history entry, so one undo goes
 * back to the link. False for any other paste, which the editor handles.
 */
export function pasteEmbed(
  view: { readonly state: EditorState; dispatch(tr: Transaction): void },
  pasted: string,
): boolean {
  const url = pasted.trim();
  if (url === "" || /\s/.test(url) || !matchEmbed(url)) return false;
  const { $from, empty } = view.state.selection;
  const line = $from.parent;
  if (!empty || $from.depth !== 1 || line.type.name !== "paragraph" || line.content.size > 0) {
    return false;
  }
  const { schema } = view.state;
  const link = schema.marks.link;
  const codeBlock = schema.nodes.codeBlock;
  const paragraph = schema.nodes.paragraph;
  if (!link || !codeBlock || !paragraph) return false;
  view.dispatch(view.state.tr.insert($from.pos, schema.text(url, [link.create({ href: url })])));
  const linked = view.state;
  const start = linked.selection.$from.before(1);
  const end = linked.selection.$from.after(1);
  const block = codeBlock.create({ language: EMBED_LANGUAGE }, schema.text(url));
  // The caret goes to a fresh line below, so the embed shows rather than its source.
  const tr = linked.tr.replaceWith(start, end, [block, paragraph.create()]);
  tr.setSelection(TextSelection.create(tr.doc, start + block.nodeSize + 1));
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}
