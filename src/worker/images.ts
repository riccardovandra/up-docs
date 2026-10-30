import { IMAGE_TYPES, imageFileType, imageUrl, MAX_IMAGE_BYTES } from "../shared/images.ts";

/** Where image bytes live; production is the `IMAGES` R2 bucket. */
export interface ImageStore {
  put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ readonly body: ReadableStream | ArrayBuffer } | null>;
  /** Removes every object under `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
}

export const imageKey = (docId: string, file: string) => `images/${docId}/${file}`;
export const docImagesPrefix = (docId: string) => `images/${docId}/`;

/** Leading bytes of each allowed type, so a renamed HTML file is not served as an image. */
function matchesType(bytes: Uint8Array, type: string): boolean {
  const starts = (...expected: ReadonlyArray<number>) =>
    expected.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string) =>
    [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  switch (type) {
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/gif":
      return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    default:
      return false;
  }
}

export type ImageUploadResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly error: string };

/** Validates and stores one upload for `docId`. The caller has checked the editor role. */
export async function uploadImage(
  store: ImageStore,
  input: { readonly docId: string; readonly request: Request },
): Promise<ImageUploadResult> {
  const type = (input.request.headers.get("Content-Type") ?? "").split(";")[0]!.trim();
  const extension = IMAGE_TYPES[type];
  if (!extension) return { ok: false, status: 415, error: "unsupported_type" };
  const declared = Number(input.request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "too_large" };
  const body = await input.request.arrayBuffer();
  if (body.byteLength > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "too_large" };
  if (
    body.byteLength === 0 ||
    !matchesType(new Uint8Array(body, 0, Math.min(12, body.byteLength)), type)
  ) {
    return { ok: false, status: 400, error: "invalid_image" };
  }
  const file = `${crypto.randomUUID()}.${extension}`;
  await store.put(imageKey(input.docId, file), body, type);
  return { ok: true, url: imageUrl(input.docId, file) };
}

/** Serves a stored image. The caller has checked the viewer role. */
export async function imageResponse(
  store: ImageStore,
  input: { readonly docId: string; readonly file: string },
): Promise<Response | null> {
  const type = imageFileType(input.file);
  if (!type) return null;
  const object = await store.get(imageKey(input.docId, input.file));
  if (!object) return null;
  return new Response(object.body, {
    headers: {
      "Content-Type": type,
      // Names are random and never reused, so the bytes never change.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export function r2ImageStore(bucket: R2Bucket): ImageStore {
  return {
    put: async (key, body, contentType) => {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    get: async (key) => {
      const object = await bucket.get(key);
      return object ? { body: object.body } : null;
    },
    deletePrefix: async (prefix) => {
      let cursor: string | undefined;
      do {
        const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    },
  };
}
