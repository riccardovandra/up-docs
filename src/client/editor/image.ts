import { flattenExtensions, mergeAttributes, Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";

import {
  IMAGE_TYPES,
  isDocImageSrc,
  joinImageAlt,
  MAX_IMAGE_WIDTH,
  MIN_IMAGE_WIDTH,
  splitImageAlt,
} from "../../shared/images.ts";
import { ImageView } from "./imageView.ts";

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

/** A stored width as a whole number of pixels in range, or null for the natural size. */
export function imageWidth(value: unknown): number | null {
  const width = Math.round(Number(value));
  if (value === null || value === "" || !Number.isFinite(width)) return null;
  return Math.min(MAX_IMAGE_WIDTH, Math.max(MIN_IMAGE_WIDTH, width));
}

const escapeAlt = (alt: string) => alt.replace(/([\\[\]])/g, "\\$1");
const markdownDestination = (src: string) => (/[\s()<>]/.test(src) ? `<${src}>` : src);

const stockParagraph = flattenExtensions([StarterKit]).find(
  (extension) => extension.name === "paragraph",
) as Node;

/**
 * StarterKit's paragraph, keeping an image alone on its line inside it. The
 * stock parser unwraps that image, assuming images are blocks, but DocImage is
 * inline, so the result breaks the schema and the first transaction on it
 * throws. The paragraph comes from StarterKit because its own package is not a
 * direct dependency.
 */
export const DocParagraph = stockParagraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens ?? [];
    if (tokens.length === 1 && tokens[0]?.type === "image") {
      return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
    }
    return stockParagraph.config.parseMarkdown?.(token, helpers) ?? [];
  },
});

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
    width: { default: null },
  }),

  parseHTML: () => [
    {
      tag: "img[src]",
      getAttrs: (element) => ({
        src: element.getAttribute("src"),
        alt: element.getAttribute("alt"),
        title: element.getAttribute("title"),
        width: imageWidth(element.getAttribute("width")),
      }),
    },
  ],

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

  parseMarkdown: (token, helpers) => {
    const { alt, width } = splitImageAlt(token.text ?? "");
    return helpers.createNode("image", {
      src: token.href ?? null,
      alt: alt || null,
      title: token.title || null,
      width,
    });
  },

  renderMarkdown: (node) => {
    const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : "";
    const width = imageWidth(node.attrs?.width);
    const alt = escapeAlt(joinImageAlt(String(node.attrs?.alt ?? ""), width));
    return `![${alt}](${markdownDestination(String(node.attrs?.src ?? ""))}${title})`;
  },

  addNodeView: () => (props) => new ImageView(props),

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
