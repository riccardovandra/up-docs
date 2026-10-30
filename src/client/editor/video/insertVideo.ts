import type { Editor } from "@tiptap/core";

import { VIDEO_LANGUAGE, videoBlockBody, videoFileTitle } from "../../../shared/video.ts";

const videoNode = (body: string) => ({
  type: "codeBlock",
  attrs: { language: VIDEO_LANGUAGE },
  ...(body ? { content: [{ type: "text", text: body }] } : {}),
});

/** An empty block with the caret in it, so its source shows for the link to be pasted. */
export function insertVideoLink(editor: Editor): void {
  editor.chain().focus().insertContent(videoNode("")).run();
}

/**
 * Adds an uploaded file. It goes after the block the drop landed in, since an
 * upload can outlast a good many edits, and the caret stays out of the block so
 * the player shows.
 */
export function insertVideoFile(
  editor: Editor,
  src: string,
  file: File,
  at: number | null = null,
): void {
  const content = [
    videoNode(videoBlockBody(src, videoFileTitle(file.name))),
    { type: "paragraph" },
  ];
  if (at === null) {
    editor.chain().focus().insertContent(content).run();
    return;
  }
  const $at = editor.state.doc.resolve(Math.min(at, editor.state.doc.content.size));
  editor
    .chain()
    .focus()
    .insertContentAt($at.depth > 0 ? $at.after(1) : $at.pos, content)
    .run();
}
