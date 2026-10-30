import { mergeAttributes, Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { IMAGE_TYPES, isDocImageSrc } from "../../shared/images.ts";

export interface DocImageOptions {
  /** Uploads one file and resolves to its URL; null when the reader cannot edit. */
  readonly upload: ((file: File) => Promise<string>) | null;
  readonly onUploadError: (error: unknown) => void;
}

const imageFiles = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((file) => Object.hasOwn(IMAGE_TYPES, file.type));

/** Attributes for an uploaded file: its name, minus the extension, is the alt text. */
export const imageAttributes = (src: string, file: File) => ({
  src,
  alt: file.name.replace(/\.[^.]+$/, "") || null,
});

const escapeAlt = (alt: string) => alt.replace(/([\\[\]])/g, "\\$1");
const markdownDestination = (src: string) => (/[\s()<>]/.test(src) ? `<${src}>` : src);

/**
 * Markdown images. Only our own `/api/images/...` sources are loaded (the CSP
 * allows nothing else either); any other src is kept in the markdown and shown
 * as its alt text, so a pasted remote URL never makes the reader's browser
 * fetch it.
 */
export const DocImage = Node.create<DocImageOptions>({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  draggable: true,
  markdownTokenName: "image",

  addOptions: () => ({ upload: null, onUploadError: () => undefined }),

  addAttributes: () => ({
    src: { default: null },
    alt: { default: null },
    title: { default: null },
  }),

  parseHTML: () => [{ tag: "img[src]" }],

  renderHTML({ node, HTMLAttributes }) {
    const src = String(node.attrs.src ?? "");
    if (isDocImageSrc(src)) {
      return ["img", mergeAttributes({ class: "doc-image", loading: "lazy" }, HTMLAttributes)];
    }
    return [
      "span",
      { class: "doc-image-blocked", title: src },
      node.attrs.alt ? `[Image: ${node.attrs.alt}]` : "[Image]",
    ];
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode("image", {
      src: token.href ?? null,
      alt: token.text || null,
      title: token.title || null,
    }),

  renderMarkdown: (node) => {
    const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : "";
    const alt = escapeAlt(String(node.attrs?.alt ?? ""));
    return `![${alt}](${markdownDestination(String(node.attrs?.src ?? ""))}${title})`;
  },

  addProseMirrorPlugins() {
    const { upload, onUploadError } = this.options;
    if (!upload) return [];
    const type = this.type;
    const insertAll = (view: EditorView, files: ReadonlyArray<File>, at: number | null) => {
      for (const file of files) {
        upload(file).then((src) => {
          // The tab may have been closed while the file uploaded.
          if (view.isDestroyed) return;
          const { state } = view;
          const pos = Math.min(at ?? state.selection.from, state.doc.content.size);
          const node = type.create(imageAttributes(src, file));
          view.dispatch(state.tr.insert(pos, node));
        }, onUploadError);
      }
    };
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (files.length === 0 || !view.editable) return false;
            insertAll(view, files, null);
            return true;
          },
          handleDrop: (view, event) => {
            const files = imageFiles(event.dataTransfer?.files);
            if (files.length === 0 || !view.editable) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            insertAll(view, files, at);
            return true;
          },
        },
      }),
    ];
  },
});
