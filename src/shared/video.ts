// Doc videos: a ```t3-video block whose first line is the source and whose
// optional second line is the title. Sources are YouTube and Loom links, or
// files uploaded to R2 and served to anyone who can read the doc.

import { findFences } from "./table.ts";

export const VIDEO_LANGUAGE = "t3-video";

export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
/** Stays under the Worker's 100 MB request limit. R2 needs every part but the last to match. */
export const VIDEO_PART_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_PARTS = Math.ceil(MAX_VIDEO_BYTES / VIDEO_PART_BYTES);

/** Upload types and the extension each is stored under. */
export const VIDEO_TYPES: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(VIDEO_TYPES).map(([type, extension]) => [extension, type]),
);

const FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm|mov)$/;
const SRC = /^\/api\/videos\/[A-Za-z0-9_-]{1,64}\/([^/?#]+)$/;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const YOUTUBE_PATH = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/;
const LOOM_HOSTS = new Set(["loom.com", "www.loom.com"]);
// Loom share links may put the video's title in front of its id.
const LOOM_PATH = /^\/(?:share|embed)\/(?:[A-Za-z0-9-]*-)?([0-9a-f]{32})\/?$/;

const MAX_SOURCE_LENGTH = 2048;

/** The content type of a stored video file name, or null if the name is not one we issue. */
export function videoFileType(file: string): string | null {
  const match = FILE.exec(file);
  return match ? (TYPE_BY_EXTENSION[match[1]!] ?? null) : null;
}

export const videoUrl = (docId: string, file: string) => `/api/videos/${docId}/${file}`;

/** The upload type of a picked or dropped file; some systems leave `type` blank for .mov. */
export function videoTypeOf(file: { readonly name: string; readonly type: string }): string | null {
  if (Object.hasOwn(VIDEO_TYPES, file.type)) return file.type;
  if (file.type !== "") return null;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return extension ? (TYPE_BY_EXTENSION[extension] ?? null) : null;
}

export type VideoBlock =
  | {
      readonly kind: "youtube" | "loom";
      readonly id: string;
      readonly title: string | null;
      readonly watchUrl: string;
      readonly embedUrl: string;
    }
  | {
      readonly kind: "file";
      readonly src: string;
      readonly title: string | null;
      readonly watchUrl: string;
      readonly embedUrl: null;
    };

function youtubeId(url: URL): string | null {
  if (url.hostname === "youtu.be") {
    return /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  if (url.pathname === "/watch" || url.pathname === "/watch/") {
    const id = url.searchParams.get("v");
    return id !== null && YOUTUBE_ID.test(id) ? id : null;
  }
  return YOUTUBE_PATH.exec(url.pathname)?.[1] ?? null;
}

function loomId(url: URL): string | null {
  return LOOM_HOSTS.has(url.hostname) ? (LOOM_PATH.exec(url.pathname)?.[1] ?? null) : null;
}

function webUrl(source: string): URL | null {
  if (!URL.canParse(source)) return null;
  const url = new URL(source);
  const web = url.protocol === "https:" || url.protocol === "http:";
  return web && url.username === "" && url.password === "" && url.port === "" ? url : null;
}

/**
 * Reads a block's text. Embed URLs are built only from a strictly matched id,
 * never from the doc's text, so nothing an author writes reaches an iframe.
 */
export function parseVideoBlock(body: string): VideoBlock | null {
  const [first = "", second = "", ...rest] = body.split("\n").map((line) => line.trim());
  if (first === "" || first.length > MAX_SOURCE_LENGTH || rest.some((line) => line !== "")) {
    return null;
  }
  const title = second === "" ? null : second;
  const file = SRC.exec(first);
  if (file) {
    if (videoFileType(file[1]!) === null) return null;
    return { kind: "file", src: first, title, watchUrl: first, embedUrl: null };
  }
  const url = webUrl(first);
  if (!url) return null;
  const youtube = youtubeId(url);
  if (youtube) {
    return {
      kind: "youtube",
      id: youtube,
      title,
      watchUrl: `https://www.youtube.com/watch?v=${youtube}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtube}?autoplay=1`,
    };
  }
  const loom = loomId(url);
  if (loom) {
    return {
      kind: "loom",
      id: loom,
      title,
      watchUrl: `https://www.loom.com/share/${loom}`,
      embedUrl: `https://www.loom.com/embed/${loom}?autoplay=1`,
    };
  }
  return null;
}

/** A block's language, ignoring anything after the first word of the info string. */
export const isVideoLanguage = (language: string | null | undefined) =>
  language?.trim().split(/\s+/, 1)[0] === VIDEO_LANGUAGE;

/** A block's text for a source and title. A title is one line. */
export function videoBlockBody(source: string, title: string | null = null): string {
  const line = title?.replace(/\s+/g, " ").trim();
  return line ? `${source}\n${line}` : source;
}

/** The title an uploaded file starts with: its name, minus the extension. */
export const videoFileTitle = (name: string) => name.replace(/\.[^.]+$/, "").trim() || null;

/** Words for a link to the video. */
export function videoLabel(video: VideoBlock): string {
  if (video.title) return video.title;
  if (video.kind === "youtube") return "YouTube video";
  return video.kind === "loom" ? "Loom video" : "Video";
}

/**
 * Every block a write adds or changes must parse. A block left byte-identical
 * to `previous` is not re-checked, so older content never blocks an unrelated edit.
 */
export function checkVideosIn(markdown: string, previous?: string): string | null {
  const blocks = findFences(markdown).filter((fence) => fence.language === VIDEO_LANGUAGE);
  const unchanged = new Set(
    findFences(previous ?? "")
      .filter((fence) => fence.language === VIDEO_LANGUAGE)
      .map((fence) => fence.body),
  );
  for (const [index, fence] of blocks.entries()) {
    if (unchanged.has(fence.body) || parseVideoBlock(fence.body)) continue;
    const which = blocks.length === 1 ? "The t3-video block" : `t3-video block ${index + 1}`;
    return `${which}: the first line must be a YouTube or Loom link, or an uploaded /api/videos/ URL, and only a title may follow it.`;
  }
  return null;
}

const escapeLinkText = (text: string) => text.replace(/([\\[\]])/g, "\\$1");

/** Blocks as markdown links, for downloads. `origin` makes an uploaded file's URL absolute. */
export function videosToLinks(markdown: string, origin: string): string {
  let result = "";
  let at = 0;
  for (const fence of findFences(markdown)) {
    if (fence.language !== VIDEO_LANGUAGE) continue;
    const video = parseVideoBlock(fence.body);
    if (!video) continue;
    const url = video.kind === "file" ? `${origin}${video.src}` : video.watchUrl;
    result += `${markdown.slice(at, fence.start)}[${escapeLinkText(videoLabel(video))}](${url})`;
    at = fence.end;
  }
  return result + markdown.slice(at);
}
