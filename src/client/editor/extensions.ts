import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

import { DocsCodeBlock } from "./codeBlock.ts";
import { HeadingFold } from "./headingFold.ts";
import { DocImage, type DocImageOptions } from "./image.ts";

/**
 * The editor's whole extension list. Every extension must round-trip through
 * markdown, since tabs are stored and served to agents as markdown (diagrams
 * are ```mermaid fenced code blocks).
 */
export const createEditorExtensions = (
  images: DocImageOptions = { upload: null, onUploadError: () => undefined },
) => [
  StarterKit.configure({ link: { openOnClick: false }, codeBlock: false }),
  DocsCodeBlock,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  DocImage.configure(images),
  HeadingFold,
  Markdown,
];
