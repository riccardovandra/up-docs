import {
  MAX_VIDEO_BYTES,
  VIDEO_PART_BYTES,
  VIDEO_TYPES,
  videoFileType,
  videoUrl,
} from "../shared/video.ts";

export interface VideoPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface VideoRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * Video bytes in the `IMAGES` R2 bucket, under their own prefix. Bytes go up in
 * parts through the Worker, so uploads need no R2 S3 credentials. There is no
 * D1 store: a deployment without a bucket has no uploads, and links still work.
 */
export interface VideoStore {
  create(key: string, contentType: string): Promise<string>;
  /** The part's etag, or null when the upload does not exist. */
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream,
  ): Promise<string | null>;
  /** The object's size, or null when the upload does not exist. */
  complete(key: string, uploadId: string, parts: ReadonlyArray<VideoPart>): Promise<number | null>;
  abort(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<{ readonly size: number } | null>;
  get(key: string, range?: VideoRange): Promise<{ readonly body: ReadableStream } | null>;
  delete(key: string): Promise<void>;
  /** Removes every object under `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
}

export const videoKey = (docId: string, file: string) => `videos/${docId}/${file}`;
export const docVideosPrefix = (docId: string) => `videos/${docId}/`;

const QUICKTIME_ATOMS = ["ftyp", "moov", "mdat", "wide", "free", "skip"];

/** Leading bytes of each allowed type, so a renamed HTML file is not served as a video. */
function matchesType(bytes: Uint8Array, type: string): boolean {
  const atom = String.fromCharCode(...bytes.subarray(4, 8));
  switch (type) {
    case "video/mp4":
      return atom === "ftyp";
    case "video/quicktime":
      // Older QuickTime files have no ftyp atom.
      return QUICKTIME_ATOMS.includes(atom);
    case "video/webm":
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    default:
      return false;
  }
}

export type VideoFailure = { readonly status: 400 | 404 | 413 | 415; readonly error: string };

export type VideoStartResult =
  | {
      readonly ok: true;
      readonly file: string;
      readonly uploadId: string;
      readonly partBytes: number;
    }
  | ({ readonly ok: false } & VideoFailure);

/** Opens an upload for `docId`. The caller has checked the editor role. */
export async function startVideoUpload(
  store: VideoStore,
  input: { readonly docId: string; readonly type: unknown; readonly size: unknown },
): Promise<VideoStartResult> {
  const { type, size } = input;
  const extension =
    typeof type === "string" && Object.hasOwn(VIDEO_TYPES, type) ? VIDEO_TYPES[type] : undefined;
  if (!extension) return { ok: false, status: 415, error: "unsupported_type" };
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return { ok: false, status: 400, error: "invalid_size" };
  }
  if (size > MAX_VIDEO_BYTES) return { ok: false, status: 413, error: "too_large" };
  const file = `${crypto.randomUUID()}.${extension}`;
  const uploadId = await store.create(videoKey(input.docId, file), type as string);
  return { ok: true, file, uploadId, partBytes: VIDEO_PART_BYTES };
}

export type VideoCompleteResult =
  | { readonly ok: true; readonly url: string }
  | ({ readonly ok: false } & VideoFailure);

/** Finishes an upload, and deletes the object if its size or leading bytes are wrong. */
export async function completeVideoUpload(
  store: VideoStore,
  input: {
    readonly docId: string;
    readonly file: string;
    readonly uploadId: string;
    readonly parts: ReadonlyArray<VideoPart>;
  },
): Promise<VideoCompleteResult> {
  const type = videoFileType(input.file);
  if (!type) return { ok: false, status: 404, error: "not_found" };
  const key = videoKey(input.docId, input.file);
  const size = await store.complete(key, input.uploadId, input.parts);
  if (size === null) return { ok: false, status: 404, error: "upload_not_found" };
  if (size > MAX_VIDEO_BYTES) {
    await store.delete(key);
    return { ok: false, status: 413, error: "too_large" };
  }
  const start = await store.get(key, { offset: 0, length: 12 });
  const bytes = start
    ? new Uint8Array(await new Response(start.body).arrayBuffer())
    : new Uint8Array();
  if (bytes.byteLength < 12 || !matchesType(bytes, type)) {
    await store.delete(key);
    return { ok: false, status: 400, error: "invalid_video" };
  }
  return { ok: true, url: videoUrl(input.docId, input.file) };
}

/**
 * The bytes a Range header asks for. Null means the header does not apply and
 * the whole file is served, which is also the answer to a multi-range request.
 */
export function parseRange(
  header: string | null,
  size: number,
): VideoRange | "unsatisfiable" | null {
  const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const length = Math.min(Number(last), size);
    return length === 0 ? "unsatisfiable" : { offset: size - length, length };
  }
  const offset = Number(first);
  if (offset >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return end < offset ? null : { offset, length: end - offset + 1 };
}

/** Serves a stored video, with ranges so readers can seek. The caller has checked the viewer role. */
export async function videoResponse(
  store: VideoStore,
  input: { readonly docId: string; readonly file: string; readonly request: Request },
): Promise<Response | null> {
  const type = videoFileType(input.file);
  if (!type) return null;
  const key = videoKey(input.docId, input.file);
  const head = await store.head(key);
  if (!head) return null;
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    // Names are random and never reused, so the bytes never change.
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (input.request.method === "HEAD") {
    return new Response(null, {
      headers: { ...headers, "Content-Length": String(head.size) },
    });
  }
  const range = parseRange(input.request.headers.get("Range"), head.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${head.size}` },
    });
  }
  const object = await store.get(key, range ?? undefined);
  if (!object) return null;
  if (!range) {
    return new Response(object.body, {
      headers: { ...headers, "Content-Length": String(head.size) },
    });
  }
  const end = range.offset + range.length - 1;
  return new Response(object.body, {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(range.length),
      "Content-Range": `bytes ${range.offset}-${end}/${head.size}`,
    },
  });
}

/** R2's NoSuchUpload, thrown when an upload id is unknown or was aborted. */
const isMissingUpload = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("10024");

async function orNull<A>(call: Promise<A>): Promise<A | null> {
  try {
    return await call;
  } catch (cause) {
    if (isMissingUpload(cause)) return null;
    throw cause;
  }
}

export function r2VideoStore(bucket: R2Bucket): VideoStore {
  return {
    create: async (key, contentType) => {
      const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
      return upload.uploadId;
    },
    uploadPart: async (key, uploadId, partNumber, body) => {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      return (await orNull(upload.uploadPart(partNumber, body)))?.etag ?? null;
    },
    complete: async (key, uploadId, parts) => {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      return (await orNull(upload.complete([...parts])))?.size ?? null;
    },
    abort: async (key, uploadId) => {
      await orNull(bucket.resumeMultipartUpload(key, uploadId).abort());
    },
    head: async (key) => {
      const object = await bucket.head(key);
      return object ? { size: object.size } : null;
    },
    get: async (key, range) => {
      const object = await bucket.get(key, range ? { range } : {});
      return object ? { body: object.body } : null;
    },
    delete: (key) => bucket.delete(key),
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
