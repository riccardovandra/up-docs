// Link embeds: a ```t3-embed block whose first line is a link and whose
// optional second line is a caption. Known providers (LinkedIn posts, X posts
// and articles) render a saved copy of the post; any other https link renders
// as a plain link card. Providers are matched on exact hosts and paths, and
// every URL the app fetches or frames is rebuilt from the ids matched here,
// never taken from the doc's text.

import { findFences } from "./table.ts";

export const EMBED_LANGUAGE = "t3-embed";

const MAX_SOURCE_LENGTH = 2048;
const MAX_CAPTION_LENGTH = 300;

export type EmbedProviderId = "linkedin" | "x";

export interface EmbedTarget {
  readonly provider: EmbedProviderId;
  readonly kind: "post" | "article";
  /** The post's id as the provider numbers it. */
  readonly id: string;
  /** Rebuilt from the id; the key a saved copy is stored under. */
  readonly canonicalUrl: string;
  /** The provider's own embed page. Null when there is none (X articles). */
  readonly frameUrl: string | null;
}

export interface EmbedBlock {
  /** The link as written, for the "Open" link and for unknown providers. */
  readonly url: string;
  readonly caption: string | null;
  /** Null for a link no provider knows: it renders as a link card. */
  readonly target: EmbedTarget | null;
}

/** A saved copy of a post, served by `POST /api/docs/:id/embeds`. Plain strings only. */
export interface EmbedSnapshot {
  readonly provider: EmbedProviderId;
  readonly kind: "post" | "article";
  readonly url: string;
  readonly author: string | null;
  readonly handle: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly publishedAt: string | null;
  /** A doc image URL (`/api/images/...`) holding a copy of the post's image. */
  readonly image: string | null;
  readonly likes: number | null;
  readonly comments: number | null;
  /** When the copy was taken, in ms since the epoch. */
  readonly fetchedAt: number;
}

export const PROVIDER_NAMES: Readonly<Record<EmbedProviderId, string>> = {
  linkedin: "LinkedIn",
  x: "X",
};

/** Hosts post images are copied from. Nothing else is fetched for an image. */
export const EMBED_IMAGE_HOSTS: Readonly<Record<EmbedProviderId, ReadonlySet<string>>> = {
  linkedin: new Set(["media.licdn.com"]),
  x: new Set(["pbs.twimg.com"]),
};

const LINKEDIN_HOST = /^(?:www\.|[a-z]{2,3}\.)?linkedin\.com$/;
const LINKEDIN_POSTS =
  /^\/posts\/[^/]*-(activity|share|ugcPost)-(\d{15,25})(?:-[A-Za-z0-9_-]*)?\/?$/;
const LINKEDIN_UPDATE =
  /^\/(?:embed\/)?feed\/update\/urn:li:(activity|share|ugcPost):(\d{15,25})\/?$/;

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);
const X_HANDLE = "[A-Za-z0-9_]{1,15}";
const X_STATUS = new RegExp(
  `^\\/(${X_HANDLE})\\/status(?:es)?\\/(\\d{1,25})(?:\\/(?:photo|video)\\/\\d)?\\/?$`,
);
const X_WEB_STATUS = /^\/i\/(?:web\/)?status\/(\d{1,25})\/?$/;
const X_ARTICLE = new RegExp(`^\\/(?:i|${X_HANDLE})\\/articles?\\/(\\d{1,25})\\/?$`);

function linkedinTarget(url: URL): EmbedTarget | null {
  if (!LINKEDIN_HOST.test(url.hostname)) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const match = LINKEDIN_POSTS.exec(path) ?? LINKEDIN_UPDATE.exec(path);
  if (!match) return null;
  const urn = `urn:li:${match[1]}:${match[2]}`;
  return {
    provider: "linkedin",
    kind: "post",
    id: match[2]!,
    canonicalUrl: `https://www.linkedin.com/feed/update/${urn}`,
    // Collapsed, as LinkedIn's own "Embed this post" gives it: long text ends in "…more".
    frameUrl: `https://www.linkedin.com/embed/feed/update/${urn}?collapsed=1`,
  };
}

function xTarget(url: URL): EmbedTarget | null {
  if (!X_HOSTS.has(url.hostname)) return null;
  const article = X_ARTICLE.exec(url.pathname);
  if (article) {
    return {
      provider: "x",
      kind: "article",
      id: article[1]!,
      canonicalUrl: `https://x.com/i/article/${article[1]}`,
      frameUrl: null,
    };
  }
  const web = X_WEB_STATUS.exec(url.pathname);
  const status = web ? null : X_STATUS.exec(url.pathname);
  const id = web?.[1] ?? status?.[2];
  if (!id) return null;
  return {
    provider: "x",
    kind: "post",
    id,
    canonicalUrl: `https://x.com/${status?.[1] ?? "i/web"}/status/${id}`,
    // X's own post embed, without its widget script. `dnt` turns off its tracking for personalisation.
    frameUrl: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true`,
  };
}

const PROVIDERS: ReadonlyArray<(url: URL) => EmbedTarget | null> = [linkedinTarget, xTarget];

/** An https link with no credentials or port, or null. */
export function webUrl(source: string): URL | null {
  if (source.length > MAX_SOURCE_LENGTH || !URL.canParse(source)) return null;
  const url = new URL(source);
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === ""
    ? url
    : null;
}

/** The provider post a link points to, or null for any other link. */
export function matchEmbed(source: string): EmbedTarget | null {
  const url = webUrl(source);
  if (!url) return null;
  for (const match of PROVIDERS) {
    const target = match(url);
    if (target) return target;
  }
  return null;
}

/** Reads a block's text: a link line and an optional caption line, nothing else. */
export function parseEmbedBlock(body: string): EmbedBlock | null {
  const [first = "", second = "", ...rest] = body.split("\n").map((line) => line.trim());
  if (rest.some((line) => line !== "")) return null;
  if (second.length > MAX_CAPTION_LENGTH || !webUrl(first)) return null;
  return { url: first, caption: second === "" ? null : second, target: matchEmbed(first) };
}

/** A block's language, ignoring anything after the first word of the info string. */
export const isEmbedLanguage = (language: string | null | undefined) =>
  language?.trim().split(/\s+/, 1)[0] === EMBED_LANGUAGE;

/**
 * Options after the language: ```t3-embed compact shows the author and the
 * first two lines only, with no image, until a reader expands it. Unknown
 * words are ignored, so later options never break older docs.
 */
export function embedOptions(info: string | null | undefined): { readonly compact: boolean } {
  const words = info?.trim().split(/\s+/).slice(1) ?? [];
  return { compact: words.includes("compact") };
}

export const embedInfoString = (compact: boolean) =>
  compact ? `${EMBED_LANGUAGE} compact` : EMBED_LANGUAGE;

/** A block's text for a link and caption. A caption is one line. */
export function embedBlockBody(url: string, caption: string | null = null): string {
  const line = caption?.replace(/\s+/g, " ").trim();
  return line ? `${url}\n${line}` : url;
}

/** Words for a link to the embed. */
export function embedLabel(block: EmbedBlock): string {
  if (block.caption) return block.caption;
  if (!block.target) return block.url;
  const provider = PROVIDER_NAMES[block.target.provider];
  return block.target.kind === "article" ? `${provider} article` : `${provider} post`;
}

/**
 * Every block a write adds or changes must parse. A block left byte-identical
 * to `previous` is not re-checked, so older content never blocks an unrelated edit.
 */
export function checkEmbedsIn(markdown: string, previous?: string): string | null {
  const blocks = findFences(markdown).filter((fence) => fence.language === EMBED_LANGUAGE);
  const unchanged = new Set(
    findFences(previous ?? "")
      .filter((fence) => fence.language === EMBED_LANGUAGE)
      .map((fence) => fence.body),
  );
  for (const [index, fence] of blocks.entries()) {
    if (unchanged.has(fence.body) || parseEmbedBlock(fence.body)) continue;
    const which = blocks.length === 1 ? "The t3-embed block" : `t3-embed block ${index + 1}`;
    return `${which}: the first line must be one https link, and only a caption of up to ${MAX_CAPTION_LENGTH} characters may follow it.`;
  }
  return null;
}

const escapeLinkText = (text: string) => text.replace(/([\\[\]])/g, "\\$1");

/** Blocks as markdown links, for downloads. */
export function embedsToLinks(markdown: string): string {
  let result = "";
  let at = 0;
  for (const fence of findFences(markdown)) {
    if (fence.language !== EMBED_LANGUAGE) continue;
    const block = parseEmbedBlock(fence.body);
    if (!block) continue;
    const href = block.target?.canonicalUrl ?? block.url;
    result += `${markdown.slice(at, fence.start)}[${escapeLinkText(embedLabel(block))}](${href})`;
    at = fence.end;
  }
  return result + markdown.slice(at);
}
