import { IMAGE_TYPES, imageFileType, imageUrl, MAX_IMAGE_BYTES } from "../shared/images.ts";

declare global {
  // In workerd, and not yet in the ES2023 lib.
  interface Uint8Array {
    toBase64(): string;
  }
  interface Uint8ArrayConstructor {
    fromBase64(text: string): Uint8Array;
  }
}

/** Where image bytes live: the `IMAGES` R2 bucket when bound, otherwise D1. */
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
  | {
      readonly ok: false;
      readonly status: 400 | 413 | 415;
      readonly error: string;
    };

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
        const listed = await bucket.list({
          prefix,
          ...(cursor ? { cursor } : {}),
        });
        if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    },
  };
}

/**
 * Image bytes in one `image_chunks` row. D1 caps a value or row at 2,000,000
 * bytes, and this is 1,800,000 in base64, leaving a margin for the other columns.
 */
export const D1_CHUNK_BYTES = 1_350_000;
const D1_CHUNK_CHARS = (D1_CHUNK_BYTES / 3) * 4;

/** Splits `images/<docId>/<file>` or the doc prefix into its parts. */
const keyParts = (key: string) => key.split("/") as [string, string, string];

/**
 * Keeps images in `image_chunks`, for a deployment with no R2 bucket. Each row
 * says how many chunks the image has, so a set with one missing reads as absent.
 * The stores do not share data: switching stores leaves existing images behind.
 *
 * Chunks are base64 text, not BLOBs. D1 sends a bound BLOB as a JSON array of
 * numbers, so a 10 MB batch exceeds its 32 MiB RPC limit and costs far more CPU
 * than a Free plan Worker has. Base64 is done natively and fits.
 */
export function d1ImageStore(db: D1Database): ImageStore {
  return {
    put: async (key, body) => {
      const [, docId, file] = keyParts(key);
      const text = new Uint8Array(body).toBase64();
      const total = Math.ceil(text.length / D1_CHUNK_CHARS);
      const insert = db.prepare(
        "INSERT INTO image_chunks (doc_id, file, seq, total, data) VALUES (?1, ?2, ?3, ?4, ?5)",
      );
      // One transaction: readers see the whole image or none of it.
      await db.batch([
        db.prepare("DELETE FROM image_chunks WHERE doc_id = ?1 AND file = ?2").bind(docId, file),
        ...Array.from({ length: total }, (_, seq) =>
          insert.bind(
            docId,
            file,
            seq,
            total,
            text.slice(seq * D1_CHUNK_CHARS, (seq + 1) * D1_CHUNK_CHARS),
          ),
        ),
      ]);
    },
    get: async (key) => {
      const [, docId, file] = keyParts(key);
      const { results } = await db
        .prepare(
          "SELECT seq, total, data FROM image_chunks WHERE doc_id = ?1 AND file = ?2 ORDER BY seq",
        )
        .bind(docId, file)
        .all<{ seq: number; total: number; data: string }>();
      if (
        results.length === 0 ||
        results.some((r, i) => r.seq !== i || r.total !== results.length)
      ) {
        return null;
      }
      // Chunks are a multiple of 3 bytes, so only the last one carries padding.
      const bytes = Uint8Array.fromBase64(results.map((row) => row.data).join(""));
      return { body: bytes.buffer as ArrayBuffer };
    },
    deletePrefix: async (prefix) => {
      const [, docId] = keyParts(prefix);
      await db.prepare("DELETE FROM image_chunks WHERE doc_id = ?1").bind(docId).run();
    },
  };
}
