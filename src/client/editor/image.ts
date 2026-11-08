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
  /**
   * Copies an image link into the doc and resolves to the copy's URL. With it,
   * an editor's open doc swaps every remote image for its copy, and pasting an
   * image link adds the image. Absent where docs have no server (local files).
   */
  readonly importLink?: ((url: string) => Promise<string>) | null;
}

/** A pasted link that names an image file, by its extension. */
export function pastedImageLink(text: string): string | null {
  const value = text.trim();
  if (value === "" || /\s/.test(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:") return null;
  return /\.(png|jpe?g|gif|webp)$/i.test(url.pathname) ? url.href : null;
}

const isRemoteSrc = (src: unknown): src is string =>
  typeof src === "string" && /^https:\/\//i.test(src);

/** Points every image whose src is `from` at `to`, outside the undo history. */
function swapImageSrc(view: EditorView, from: string, to: string): void {
  const { tr } = view.state;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "image" && node.attrs.src === from) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: to });
    }
  });
  if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
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
const markdownDestination = (src: string) =>
  /[\s()<>]/.test(src) ? `<${src}>` : src;

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
      return helpers.createNode(
        "paragraph",
        undefined,
        helpers.parseInline(tokens),
      );
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

  addOptions: () => ({
    upload: null,
    onUploadError: () => undefined,
    importLink: null,
  }),

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
      return [
        "img",
        mergeAttributes(
          { class: "doc-image", loading: "lazy" },
          HTMLAttributes,
        ),
      ];
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
    const title = node.attrs?.title
      ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"`
      : "";
    const width = imageWidth(node.attrs?.width);
    const alt = escapeAlt(joinImageAlt(String(node.attrs?.alt ?? ""), width));
    return `![${alt}](${markdownDestination(String(node.attrs?.src ?? ""))}${title})`;
  },

  addNodeView: () => (props) => new ImageView(props),

  addProseMirrorPlugins() {
    const { upload, onUploadError, importLink } = this.options;
    if (!upload) return [];
    const type = this.type;
    const plugins: Array<Plugin> = [];
    if (importLink) {
      // Remote images are copied once per link per editor session; a link that
      // fails stays as written and keeps showing its alt text.
      const attempted = new Set<string>();
      const importAll = (view: EditorView) => {
        if (!view.editable) return;
        view.state.doc.descendants((node) => {
          const src = node.type.name === "image" ? node.attrs.src : null;
          if (!isRemoteSrc(src) || attempted.has(src)) return;
          attempted.add(src);
          importLink(src).then(
            (copy) => {
              if (!view.isDestroyed) swapImageSrc(view, src, copy);
            },
            () => undefined,
          );
        });
      };
      plugins.push(
        new Plugin({
          view: (view) => {
            importAll(view);
            return {
              update: (updated, previous) => {
                if (!updated.state.doc.eq(previous.doc)) importAll(updated);
              },
            };
          },
          props: {
            handlePaste: (view, event) => {
              if (
                !view.editable ||
                imageFiles(event.clipboardData?.files).length > 0
              )
                return false;
              const link = pastedImageLink(
                event.clipboardData?.getData("text/plain") ?? "",
              );
              if (
                link === null ||
                view.state.selection.$from.parent.type.spec.code
              )
                return false;
              const at = view.state.selection.from;
              importLink(link).then(
                (src) => {
                  if (view.isDestroyed) return;
                  const pos = Math.min(at, view.state.doc.content.size);
                  view.dispatch(
                    view.state.tr.insert(pos, type.create({ src, alt: null })),
                  );
                },
                (error: unknown) => {
                  if (view.isDestroyed) return;
                  // Not importable: paste the link as text instead, and say why.
                  const pos = Math.min(at, view.state.doc.content.size);
                  view.dispatch(view.state.tr.insertText(link, pos));
                  onUploadError(error);
                },
              );
              return true;
            },
          },
        }),
      );
    }
    const insertAll = (
      view: EditorView,
      files: ReadonlyArray<File>,
      at: number | null,
    ) => {
      for (const file of files) {
        upload(file).then((src) => {
          // The tab may have been closed while the file uploaded.
          if (view.isDestroyed) return;
          const { state } = view;
          const pos = Math.min(
            at ?? state.selection.from,
            state.doc.content.size,
          );
          const node = type.create(imageAttributes(src, file));
          view.dispatch(state.tr.insert(pos, node));
        }, onUploadError);
      }
    };
    return [
      ...plugins,
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
            const at =
              view.posAtCoords({ left: event.clientX, top: event.clientY })
                ?.pos ?? null;
            insertAll(view, files, at);
            return true;
          },
        },
      }),
    ];
  },
});
