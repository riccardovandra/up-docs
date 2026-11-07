// Saved copies of embedded posts. The first reader of a ```t3-embed block asks
// for its copy; the Worker fetches the post once from the provider, keeps its
// text as plain strings in D1 and its image as a doc image, and serves that copy
// from then on. Posts get deleted and provider image URLs expire; the copy does
// not. No provider HTML ever reaches a reader.

import {
  EMBED_IMAGE_HOSTS,
  type EmbedProviderId,
  type EmbedSnapshot,
  type EmbedTarget,
} from "../shared/embeds.ts";
import { IMAGE_TYPES, imageUrl } from "../shared/images.ts";
import { imageKey, type ImageStore, matchesType } from "./images.ts";

/** Fetches a provider URL. The Worker's own `fetch`; tests pass a stub. */
export type RemoteFetch = (request: Request) => Promise<Response>;

export interface EmbedDeps {
  readonly db: D1Database;
  readonly images: ImageStore;
  readonly fetchRemote: RemoteFetch;
  readonly now: () => number;
}

export type EmbedResult =
  | { readonly ok: true; readonly snapshot: EmbedSnapshot }
  | { readonly ok: false; readonly status: 429 | 502; readonly error: string };

const USER_AGENT =
  "Mozilla/5.0 (compatible; UPDocs/1.0; +https://github.com/riccardovandra/up-docs)";
const TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Copies per doc. A study with a few hundred posts fits; a loop asking for ids does not. */
export const MAX_EMBEDS_PER_DOC = 500;
const MAX_TEXT = 10_000;
const MAX_LINE = 300;

const LINKEDIN_PAGE_HOST = /^(?:www\.|[a-z]{2,3}\.)?linkedin\.com$/;
const X_PAGE_HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com"]);
const X_DATA_HOST = "cdn.syndication.twimg.com";

/** Whether a fetch may go to (or be redirected to) `host` for this provider. */
const PAGE_HOSTS: Readonly<Record<EmbedProviderId, (host: string) => boolean>> = {
  linkedin: (host) => LINKEDIN_PAGE_HOST.test(host),
  x: (host) => X_PAGE_HOSTS.has(host) || host === X_DATA_HOST,
};

/** The fields a provider page or feed yields, before the image is copied. */
export interface FetchedPost {
  readonly author: string | null;
  /** The author's profile line, as LinkedIn shows it under their name. */
  readonly headline: string | null;
  readonly authorImageSource: string | null;
  readonly handle: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly publishedAt: string | null;
  readonly imageSource: string | null;
  readonly likes: number | null;
  readonly comments: number | null;
}

// ---------------------------------------------------------------------------
// Fetching

/**
 * GETs `url`, following up to three redirects that stay on `allowed` hosts,
 * and reads at most `maxBytes`. Null on any failure.
 */
export async function fetchLimited(
  fetchRemote: RemoteFetch,
  url: string,
  allowed: (host: string) => boolean,
  maxBytes: number,
  headers: Record<string, string>,
): Promise<{ readonly response: Response; readonly bytes: Uint8Array } | null> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "https:" || !allowed(current.hostname)) return null;
    const response = await fetchRemote(
      new Request(current.href, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location || !URL.canParse(location, current)) return null;
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const declared = Number(response.headers.get("Content-Length") ?? "0");
    if (declared > maxBytes) {
      await response.body.cancel();
      return null;
    }
    const bytes = await readAtMost(response.body, maxBytes);
    return bytes ? { response, bytes } : null;
  }
  return null;
}

async function readAtMost(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The token X's own embed widget sends with a post id. */
export function xToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/** Fetches and reads a post. Null when the provider refuses or the page has no post in it. */
export async function fetchPost(
  target: EmbedTarget,
  fetchRemote: RemoteFetch,
): Promise<FetchedPost | null> {
  const allowed = PAGE_HOSTS[target.provider];
  try {
    if (target.provider === "linkedin") {
      const page = await fetchLimited(fetchRemote, target.canonicalUrl, allowed, MAX_PAGE_BYTES, {
        Accept: "text/html",
        "Accept-Language": "en",
      });
      const post = page ? linkedinPost(text(page.bytes)) : null;
      if (!post || !target.frameUrl) return post;
      // The headline is on LinkedIn's embed page only. Without it the copy still stands.
      const embed = await fetchLimited(fetchRemote, target.frameUrl, allowed, MAX_PAGE_BYTES, {
        Accept: "text/html",
        "Accept-Language": "en",
      }).catch(() => null);
      return embed ? { ...post, headline: linkedinHeadline(text(embed.bytes)) } : post;
    }
    if (target.kind === "post") {
      const url = `https://${X_DATA_HOST}/tweet-result?id=${target.id}&lang=en&token=${xToken(target.id)}`;
      const data = await fetchLimited(fetchRemote, url, allowed, MAX_PAGE_BYTES, {
        Accept: "application/json",
      });
      return data ? xPost(JSON.parse(text(data.bytes)) as unknown) : null;
    }
    // X serves an article's Open Graph tags to its own crawler only.
    const page = await fetchLimited(fetchRemote, target.canonicalUrl, allowed, MAX_PAGE_BYTES, {
      Accept: "text/html",
      "User-Agent": "Twitterbot/1.0",
    });
    const article = page ? openGraphPost(text(page.bytes)) : null;
    return article && !isGenericXPage(article) ? article : null;
  } catch {
    return null;
  }
}

/** Copies a post image into the doc's images. Null when it is not an image we accept. */
async function copyImage(
  deps: EmbedDeps,
  docId: string,
  provider: EmbedProviderId,
  source: string,
): Promise<string | null> {
  const hosts = EMBED_IMAGE_HOSTS[provider];
  try {
    const fetched = await fetchLimited(
      deps.fetchRemote,
      source,
      (host) => hosts.has(host),
      MAX_IMAGE_BYTES,
      { Accept: "image/webp,image/png,image/jpeg,image/gif" },
    );
    if (!fetched) return null;
    const type = (fetched.response.headers.get("Content-Type") ?? "").split(";")[0]!.trim();
    const extension = IMAGE_TYPES[type];
    if (!extension || fetched.bytes.byteLength === 0) return null;
    if (!matchesType(fetched.bytes.subarray(0, 12), type)) return null;
    const file = `${crypto.randomUUID()}.${extension}`;
    const body = fetched.bytes.buffer.slice(
      fetched.bytes.byteOffset,
      fetched.bytes.byteOffset + fetched.bytes.byteLength,
    ) as ArrayBuffer;
    await deps.images.put(imageKey(docId, file), body, type);
    return imageUrl(docId, file);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading pages. Only plain strings come out; every value is length-capped.

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** `og:*`, `twitter:*` and `description` meta tags, first value wins. */
export function metaTags(html: string): ReadonlyMap<string, string> {
  const tags = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? "");
    }
    const key = attrs.get("property") ?? attrs.get("name");
    const content = attrs.get("content");
    if (key && content !== undefined && !tags.has(key.toLowerCase())) {
      tags.set(key.toLowerCase(), decodeEntities(content));
    }
  }
  return tags;
}

/** Objects from every JSON-LD script, with `@graph` lists flattened. */
export function jsonLd(html: string): ReadonlyArray<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) {
      found.push(value);
      if (Array.isArray(value["@graph"])) value["@graph"].forEach(visit);
    }
  };
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const [, body] of scripts) {
    try {
      visit(JSON.parse(body!));
    } catch {
      // A broken block is skipped; another may still hold the post.
    }
  }
  return found;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\r\n?/g, "\n").trim();
  if (trimmed === "") return null;
  const chars = Array.from(trimmed);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : trimmed;
}

const line = (value: unknown) =>
  clean(typeof value === "string" ? value.replace(/\s+/g, " ") : value, MAX_LINE);

function count(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function imageOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return imageOf(value[0]);
  return isRecord(value) && typeof value.url === "string" ? value.url : null;
}

function interaction(posting: Record<string, unknown>, action: string): number | null {
  const stats = Array.isArray(posting.interactionStatistic) ? posting.interactionStatistic : [];
  for (const stat of stats) {
    if (
      isRecord(stat) &&
      typeof stat.interactionType === "string" &&
      stat.interactionType.endsWith(action)
    ) {
      return count(stat.userInteractionCount);
    }
  }
  return null;
}

const POSTING_TYPES = new Set([
  "SocialMediaPosting",
  "DiscussionForumPosting",
  "Article",
  "NewsArticle",
]);

/** A LinkedIn post page: its SocialMediaPosting JSON-LD, with Open Graph tags as a fallback. */
export function linkedinPost(html: string): FetchedPost | null {
  const posting = jsonLd(html).find((item) => POSTING_TYPES.has(String(item["@type"])));
  const meta = metaTags(html);
  const author = posting
    ? Array.isArray(posting.author)
      ? posting.author[0]
      : posting.author
    : undefined;
  const post: FetchedPost = {
    author: line(isRecord(author) ? author.name : null),
    headline: null,
    authorImageSource: isRecord(author) ? imageOf(author.image) : null,
    handle: null,
    title: line(posting?.headline ?? meta.get("og:title")),
    text: clean(posting?.articleBody ?? posting?.text ?? meta.get("og:description"), MAX_TEXT),
    publishedAt: line(posting?.datePublished),
    imageSource: imageOf(posting?.image) ?? meta.get("og:image") ?? null,
    likes: posting ? interaction(posting, "LikeAction") : null,
    comments: posting
      ? (count(posting.commentCount) ?? interaction(posting, "CommentAction"))
      : null,
  };
  // A sign-in wall has generic tags and no post: not worth keeping.
  return posting && (post.text || post.title) ? post : null;
}

/** An X post from the feed X's embed widget reads. */
export function xPost(data: unknown): FetchedPost | null {
  if (!isRecord(data) || data.__typename !== "Tweet") return null;
  const user = isRecord(data.user) ? data.user : {};
  const note = (
    data.note_tweet as { note_tweet_results?: { result?: { text?: unknown } } } | undefined
  )?.note_tweet_results?.result?.text;
  let body = typeof note === "string" ? note : typeof data.text === "string" ? data.text : "";
  const entities = isRecord(data.entities) ? data.entities : {};
  // Media links are the image itself, shown below. X's display range is
  // sometimes a character off, so the links are removed by value instead.
  for (const entry of Array.isArray(entities.media) ? entities.media : []) {
    if (isRecord(entry) && typeof entry.url === "string") body = body.split(entry.url).join("");
  }
  for (const entry of Array.isArray(entities.urls) ? entities.urls : []) {
    if (
      isRecord(entry) &&
      typeof entry.url === "string" &&
      typeof entry.expanded_url === "string"
    ) {
      body = body.split(entry.url).join(entry.expanded_url);
    }
  }
  const media = Array.isArray(data.mediaDetails) ? data.mediaDetails[0] : undefined;
  const photo = Array.isArray(data.photos) ? data.photos[0] : undefined;
  const avatar =
    typeof user.profile_image_url_https === "string" ? user.profile_image_url_https : null;
  const post: FetchedPost = {
    author: line(user.name),
    headline: null,
    // "_normal" is 48 px; "_bigger" is 73 px, sharp at the size the card shows.
    authorImageSource: avatar?.replace(/_normal(\.[a-z]+)$/i, "_bigger$1") ?? null,
    handle: line(user.screen_name),
    title: null,
    text: clean(decodeEntities(body), MAX_TEXT),
    publishedAt: line(data.created_at),
    imageSource:
      (isRecord(media) && typeof media.media_url_https === "string"
        ? media.media_url_https
        : null) ??
      (isRecord(photo) && typeof photo.url === "string" ? photo.url : null) ??
      cardImage(data.card),
    likes: count(data.favorite_count),
    comments: count(data.conversation_count),
  };
  return post.text || post.imageSource ? post : null;
}

/** The preview image of a link a post shares, such as an X article it announces. */
function cardImage(card: unknown): string | null {
  const values = isRecord(card) && isRecord(card.binding_values) ? card.binding_values : null;
  if (!values) return null;
  for (const name of [
    "photo_image_full_size_large",
    "thumbnail_image_large",
    "summary_photo_image_large",
  ]) {
    const value = values[name];
    const image = isRecord(value) && isRecord(value.image_value) ? value.image_value.url : null;
    if (typeof image === "string") return image;
  }
  return null;
}

/** X's page for a missing or private article: its site-wide tags, not the article's. */
export const isGenericXPage = (post: FetchedPost) =>
  post.text === null &&
  (post.title === null ||
    /^X\b|Everything App/.test(post.title) ||
    (post.imageSource ?? "").includes("/default-og"));

/**
 * The author's headline from LinkedIn's embed page: the first paragraph after
 * the link to their profile. Null when the page is laid out some other way.
 */
export function linkedinHeadline(html: string): string | null {
  const at = html.search(/data-tracking-control-name="public_post_embed_feed-actor-name"/);
  if (at === -1) return null;
  const after = html.slice(at, at + 4000);
  const paragraph = /<\/a>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/.exec(after)?.[1];
  if (paragraph === undefined) return null;
  const words = decodeEntities(paragraph.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""));
  return line(words);
}

/** Any page's Open Graph tags. */
export function openGraphPost(html: string): FetchedPost | null {
  const meta = metaTags(html);
  const post: FetchedPost = {
    author: line(meta.get("article:author") ?? null),
    headline: null,
    authorImageSource: null,
    handle: null,
    title: line(meta.get("og:title") ?? meta.get("twitter:title")),
    text: clean(
      meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"),
      MAX_TEXT,
    ),
    publishedAt: line(meta.get("article:published_time") ?? null),
    imageSource: meta.get("og:image") ?? meta.get("twitter:image") ?? null,
    likes: null,
    comments: null,
  };
  return post.title || post.text ? post : null;
}

// ---------------------------------------------------------------------------
// Storage

export async function savedEmbed(
  db: D1Database,
  docId: string,
  url: string,
): Promise<EmbedSnapshot | null> {
  const row = await db
    .prepare("SELECT data FROM embed_snapshots WHERE doc_id = ? AND url = ?")
    .bind(docId, url)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as EmbedSnapshot) : null;
}

/**
 * The doc's copy of a post, taking it now if there is none. `refresh` takes a
 * new one; when that fails the old copy stays.
 */
export async function loadEmbed(
  deps: EmbedDeps,
  input: { readonly docId: string; readonly target: EmbedTarget; readonly refresh: boolean },
): Promise<EmbedResult> {
  const { docId, target } = input;
  const existing = await savedEmbed(deps.db, docId, target.canonicalUrl);
  if (existing && !input.refresh) return { ok: true, snapshot: existing };
  if (!existing) {
    const row = await deps.db
      .prepare("SELECT count(*) AS n FROM embed_snapshots WHERE doc_id = ?")
      .bind(docId)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= MAX_EMBEDS_PER_DOC)
      return { ok: false, status: 429, error: "embed_limit" };
  }
  const post = await fetchPost(target, deps.fetchRemote);
  if (!post) return { ok: false, status: 502, error: "embed_unavailable" };
  const [image, authorImage] = await Promise.all([
    post.imageSource ? copyImage(deps, docId, target.provider, post.imageSource) : null,
    post.authorImageSource ? copyImage(deps, docId, target.provider, post.authorImageSource) : null,
  ]);
  const now = deps.now();
  const snapshot: EmbedSnapshot = {
    provider: target.provider,
    kind: target.kind,
    url: target.canonicalUrl,
    author: post.author,
    headline: post.headline,
    authorImage: authorImage ?? (input.refresh ? (existing?.authorImage ?? null) : null),
    handle: post.handle,
    title: post.title,
    text: post.text,
    publishedAt: post.publishedAt,
    image: image ?? (input.refresh ? (existing?.image ?? null) : null),
    likes: post.likes,
    comments: post.comments,
    fetchedAt: now,
  };
  await deps.db
    .prepare(
      `INSERT INTO embed_snapshots (doc_id, url, data, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (doc_id, url) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    )
    .bind(docId, target.canonicalUrl, JSON.stringify(snapshot), now)
    .run();
  return { ok: true, snapshot };
}
