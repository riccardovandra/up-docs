// Images that arrive as a link or from an agent's own machine. A link is
// downloaded once by the Worker and kept as a doc image, so readers never
// contact the other site and the image outlives the link (Google Docs image
// links expire within hours). A file comes through a one-time upload link,
// because an agent cannot send megabytes of bytes as tool-call text.

import { IMAGE_TYPES, imageUrl, MAX_IMAGE_BYTES } from "../shared/images.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { fetchLimited, type RemoteFetch } from "./embeds.ts";
import { imageKey, type ImageStore, matchesType } from "./images.ts";

export interface ImportDeps {
  readonly db: D1Database;
  readonly images: ImageStore;
  readonly fetchRemote: RemoteFetch;
  readonly now: () => number;
  /** This app's own host names, which an import never fetches. */
  readonly ownHosts: ReadonlySet<string>;
}

/** Links imported by one agent write; the rest are reported, not fetched. */
export const MAX_IMPORTS_PER_WRITE = 20;
/** Imported links per doc, so a loop cannot fill the bucket. */
export const MAX_IMPORTS_PER_DOC = 500;
export const MAX_SOURCE_URL_LENGTH = 2048;
/** How long a prepare_image_upload link works. */
export const UPLOAD_LINK_TTL_MS = 10 * 60 * 1000;

export type ImportFailure =
  | "invalid_url"
  | "blocked_host"
  | "download_failed"
  | "not_an_image"
  | "too_many_imports";

export type ImportResult =
  | { readonly ok: true; readonly src: string }
  | { readonly ok: false; readonly error: ImportFailure };

export const IMPORT_FAILURE_MESSAGES: Readonly<Record<ImportFailure, string>> =
  {
    invalid_url: "Not an https link.",
    blocked_host:
      "Links to IP addresses, local names or this app are not fetched.",
    download_failed:
      "Could not download it: the site refused, it timed out, or it is over 10 MB. A link that needs a sign-in cannot be imported; upload the file with prepare_image_upload instead.",
    not_an_image: "The link is not a PNG, JPEG, GIF or WebP image.",
    too_many_imports: "This doc has reached its limit of imported images.",
  };

// ---------------------------------------------------------------------------
// Which links may be fetched

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
];

/**
 * Whether an import may fetch from (or be redirected to) `host`. Only public
 * DNS names: no IP addresses in any notation, no single-label or local names,
 * and not this app, whose API would answer with a reader's access.
 */
export function isFetchableHost(
  host: string,
  ownHosts: ReadonlySet<string>,
): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name.length === 0 || name.length > 253) return false;
  if (name.includes(":") || name.startsWith("[")) return false;
  if (/^[0-9.]+$/.test(name) || /^0x[0-9a-f]+$/.test(name)) return false;
  if (!name.includes(".") || name === "localhost") return false;
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  return !ownHosts.has(name);
}

/** The link as a URL when it is one an import may try, else the reason not. */
function sourceUrl(
  link: string,
  ownHosts: ReadonlySet<string>,
): URL | "invalid_url" | "blocked_host" {
  if (link.length > MAX_SOURCE_URL_LENGTH || !URL.canParse(link))
    return "invalid_url";
  const url = new URL(link);
  if (url.protocol !== "https:" || url.username || url.password)
    return "invalid_url";
  if (url.port !== "" && url.port !== "443") return "blocked_host";
  return isFetchableHost(url.hostname, ownHosts) ? url : "blocked_host";
}

/** The image type the bytes start with, whatever the server called them. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 12);
  return (
    Object.keys(IMAGE_TYPES).find((type) => matchesType(head, type)) ?? null
  );
}

// ---------------------------------------------------------------------------
// Importing one link

/**
 * Copies the image at `link` into `docId`'s images and returns its path. The
 * same link in the same doc returns the earlier copy. The caller has checked
 * the editor role.
 */
export async function importImage(
  deps: ImportDeps,
  input: { readonly docId: string; readonly link: string },
): Promise<ImportResult> {
  const url = sourceUrl(input.link.trim(), deps.ownHosts);
  if (typeof url === "string") return { ok: false, error: url };
  const existing = await deps.db
    .prepare(
      "SELECT file FROM image_imports WHERE doc_id = ?1 AND source_url = ?2",
    )
    .bind(input.docId, url.href)
    .first<{ file: string }>();
  if (existing) return { ok: true, src: imageUrl(input.docId, existing.file) };

  const count = await deps.db
    .prepare("SELECT COUNT(*) AS n FROM image_imports WHERE doc_id = ?1")
    .bind(input.docId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_IMPORTS_PER_DOC)
    return { ok: false, error: "too_many_imports" };

  let fetched: Awaited<ReturnType<typeof fetchLimited>>;
  try {
    fetched = await fetchLimited(
      deps.fetchRemote,
      url.href,
      (host) => isFetchableHost(host, deps.ownHosts),
      MAX_IMAGE_BYTES,
      { Accept: "image/webp,image/png,image/jpeg,image/gif" },
    );
  } catch {
    fetched = null;
  }
  if (!fetched) return { ok: false, error: "download_failed" };
  const type = sniffImageType(fetched.bytes);
  if (!type) return { ok: false, error: "not_an_image" };

  const file = `${crypto.randomUUID()}.${IMAGE_TYPES[type]}`;
  const body = fetched.bytes.buffer.slice(
    fetched.bytes.byteOffset,
    fetched.bytes.byteOffset + fetched.bytes.byteLength,
  ) as ArrayBuffer;
  await deps.images.put(imageKey(input.docId, file), body, type);
  // Two imports of one link at once both store; the first row wins, and the
  // other copy is never referenced.
  await deps.db
    .prepare(
      "INSERT OR IGNORE INTO image_imports (doc_id, source_url, file, imported_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(input.docId, url.href, file, deps.now())
    .run();
  const kept = await deps.db
    .prepare(
      "SELECT file FROM image_imports WHERE doc_id = ?1 AND source_url = ?2",
    )
    .bind(input.docId, url.href)
    .first<{ file: string }>();
  return { ok: true, src: imageUrl(input.docId, kept?.file ?? file) };
}

// ---------------------------------------------------------------------------
// Image links in markdown

export interface ImageLink {
  /** Offsets of the link destination in the markdown, brackets included. */
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const IMAGE =
  /!\[(?:\\.|[^\\\]\n])*\]\(\s*(<[^<>\n]*>|[^\s()<>]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** Blanks inline code spans, keeping offsets, so images inside them are not seen. */
const maskInlineCode = (line: string) =>
  line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length));

/**
 * The https destinations of markdown images (`![alt](https://...)`) outside
 * code. Fenced blocks, which include diagrams, tables and embeds, are skipped.
 */
export function findImageLinks(markdown: string): ReadonlyArray<ImageLink> {
  const links: Array<ImageLink> = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const opener = FENCE.exec(line);
    if (fence) {
      if (
        opener &&
        opener[1]![0] === fence.char &&
        opener[1]!.length >= fence.length
      ) {
        if (line.slice(opener[0].length).trim() === "") fence = null;
      }
    } else if (opener) {
      fence = { char: opener[1]![0]!, length: opener[1]!.length };
    } else {
      const masked = maskInlineCode(line);
      for (const match of masked.matchAll(IMAGE)) {
        const destination = match[1]!;
        const at =
          match.index! + match[0].indexOf(destination, match[0].indexOf("]("));
        const url = destination.startsWith("<")
          ? destination.slice(1, -1)
          : destination;
        if (/^https:\/\//i.test(url)) {
          links.push({
            start: offset + at,
            end: offset + at + destination.length,
            url,
          });
        }
      }
    }
    offset += line.length + 1;
  }
  return links;
}

export interface ImportReport {
  readonly imported: ReadonlyArray<{
    readonly url: string;
    readonly src: string;
  }>;
  readonly failed: ReadonlyArray<{
    readonly url: string;
    readonly error: ImportFailure | "over_limit";
    readonly message: string;
  }>;
}

/**
 * Imports every remote image link in `markdown` and returns the markdown with
 * each one pointing at its copy. A link that fails stays as written, so the
 * write still goes through and the reader sees its alt text, as before.
 * Report is null when the markdown has no remote image links.
 */
export async function importMarkdownImages(
  deps: ImportDeps,
  input: { readonly docId: string; readonly markdown: string },
): Promise<{
  readonly markdown: string;
  readonly report: ImportReport | null;
}> {
  const links = findImageLinks(input.markdown);
  if (links.length === 0) return { markdown: input.markdown, report: null };
  const unique = [...new Set(links.map((link) => link.url))];
  const attempted = unique.slice(0, MAX_IMPORTS_PER_WRITE);
  const results = await Promise.all(
    attempted.map((link) => importImage(deps, { docId: input.docId, link })),
  );
  const sources = new Map<string, string>();
  const imported: Array<{ url: string; src: string }> = [];
  const failed: Array<ImportReport["failed"][number]> = [];
  attempted.forEach((url, index) => {
    const result = results[index]!;
    if (result.ok) {
      sources.set(url, result.src);
      imported.push({ url, src: result.src });
    } else {
      failed.push({
        url,
        error: result.error,
        message: IMPORT_FAILURE_MESSAGES[result.error],
      });
    }
  });
  for (const url of unique.slice(MAX_IMPORTS_PER_WRITE)) {
    failed.push({
      url,
      error: "over_limit",
      message: `Only ${MAX_IMPORTS_PER_WRITE} links are imported per write. Write the rest in another edit.`,
    });
  }
  let markdown = input.markdown;
  for (const link of [...links].reverse()) {
    const src = sources.get(link.url);
    if (src)
      markdown = markdown.slice(0, link.start) + src + markdown.slice(link.end);
  }
  return { markdown, report: { imported, failed } };
}

// ---------------------------------------------------------------------------
// One-time upload links

/** Makes a link `userId` can upload one image to `docId` with, and returns its token. */
export async function createUploadToken(
  db: D1Database,
  input: {
    readonly docId: string;
    readonly userId: string;
    readonly now: number;
  },
): Promise<{ readonly token: string; readonly expiresAt: number }> {
  const token = randomToken();
  const expiresAt = input.now + UPLOAD_LINK_TTL_MS;
  await db.batch([
    db
      .prepare("DELETE FROM image_upload_tokens WHERE expires_at < ?1")
      .bind(input.now),
    db
      .prepare(
        "INSERT INTO image_upload_tokens (token_hash, doc_id, user_id, expires_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(await sha256Hex(token), input.docId, input.userId, expiresAt),
  ]);
  return { token, expiresAt };
}

/**
 * Claims an unused, unexpired upload token, so a second request with it
 * fails. `release` gives it back when the upload was refused, so an agent
 * that sent the wrong file can retry within the time left.
 */
export async function claimUploadToken(
  db: D1Database,
  input: { readonly token: string; readonly now: number },
): Promise<{
  readonly docId: string;
  readonly userId: string;
  readonly release: () => Promise<void>;
} | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.token)) return null;
  const hash = await sha256Hex(input.token);
  const row = await db
    .prepare(
      "UPDATE image_upload_tokens SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING doc_id, user_id",
    )
    .bind(hash, input.now)
    .first<{ doc_id: string; user_id: string }>();
  if (!row) return null;
  return {
    docId: row.doc_id,
    userId: row.user_id,
    release: async () => {
      await db
        .prepare(
          "UPDATE image_upload_tokens SET used_at = NULL WHERE token_hash = ?1",
        )
        .bind(hash)
        .run();
    },
  };
}

/** The markdown line for an image. */
export const imageMarkdown = (src: string, alt: string) =>
  `![${alt.replace(/([\\[\]])/g, "\\$1")}](${src})`;
