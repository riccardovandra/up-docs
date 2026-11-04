import type { Editor } from "@tiptap/core";

import { EMBED_LANGUAGE } from "../../../shared/embeds.ts";

/** An empty block with the caret in it, so its source shows for the link to be pasted. */
export function insertEmbedLink(editor: Editor): void {
  editor
    .chain()
    .focus()
    .insertContent({ type: "codeBlock", attrs: { language: EMBED_LANGUAGE } })
    .run();
}
