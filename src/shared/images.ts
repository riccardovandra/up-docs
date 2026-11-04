// Doc images: uploaded to R2, or D1 without a bucket, and referenced from markdown by a relative URL
// that the API serves to anyone who can read the doc.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Upload types and the extension each is stored under. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([type, extension]) => [extension, type]),
);

const FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SRC = /^\/api\/images\/([A-Za-z0-9_-]{1,64})\/([^/?#]+)$/;

/** The content type of a stored image file name, or null if the name is not one we issue. */
export function imageFileType(file: string): string | null {
  const match = FILE.exec(file);
  return match ? (TYPE_BY_EXTENSION[match[1]!] ?? null) : null;
}

export const isImageDocId = (docId: string) => ID.test(docId);

export const imageUrl = (docId: string, file: string) => `/api/images/${docId}/${file}`;

/**
 * Whether an image src is one of ours. The editor only loads these; anything
 * else in markdown (an agent pasting a remote URL) is kept but not fetched.
 */
export function isDocImageSrc(src: string): boolean {
  const match = SRC.exec(src);
  return match !== null && imageFileType(match[2]!) !== null;
}

/** Narrowest and widest width, in CSS pixels, an image can be resized to. */
export const MIN_IMAGE_WIDTH = 48;
export const MAX_IMAGE_WIDTH = 4000;

const ALT_WIDTH = /^(.*)\|(\d{1,4})$/s;

/**
 * Splits markdown alt text into the alt and a display width. A resized image
 * stores its width after a pipe, as in `![Chart|480](/api/images/...)`, the
 * convention Obsidian uses; plain alt text has no width.
 */
export function splitImageAlt(text: string): {
  readonly alt: string;
  readonly width: number | null;
} {
  const match = ALT_WIDTH.exec(text);
  const width = match ? Number(match[2]) : NaN;
  if (!match || width < MIN_IMAGE_WIDTH || width > MAX_IMAGE_WIDTH)
    return { alt: text, width: null };
  return { alt: match[1]!, width };
}

/** The alt text that stores `alt` and `width`; the inverse of splitImageAlt. */
export const joinImageAlt = (alt: string, width: number | null) =>
  width === null ? alt : `${alt}|${width}`;
