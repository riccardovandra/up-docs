// Pages: uploaded HTML files (interactive prototypes) as library items of
// their own. Each upload is a new version and older versions stay readable. A
// doc shows one through a ```t3-page block: the page id, an optional
// `height: <px>` line, then an optional caption. The HTML always runs in a
// sandboxed frame with an opaque origin, never on the app's own origin
// (see worker/htmlPages.ts, `pageContentResponse`).

import type { DocRole } from "./access.ts";
import { findFences } from "./table.ts";

export const PAGE_LANGUAGE = "t3-page";

/** The largest HTML file a page version may hold. */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PAGE_TITLE_LENGTH = 200;
export const MAX_PAGE_NOTE_LENGTH = 500;
export const MAX_PAGE_CAPTION_LENGTH = 300;
/** A block's frame height, in CSS pixels. */
export const MIN_PAGE_HEIGHT = 200;
export const MAX_PAGE_HEIGHT = 4000;
export const DEFAULT_PAGE_HEIGHT = 720;
export const DEFAULT_PAGE_TITLE = "Untitled page";

/**
 * What the content frame may do. Scripts run, links open new tabs, forms and
 * dialogs work, files download. No `allow-same-origin`: the page gets an
 * opaque origin, so it cannot read the app's cookies, storage or API. No
 * `allow-top-navigation`: it cannot move the app away.
 */
export const PAGE_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isPageId = (value: string) => ID.test(value);

export const pagePath = (pageId: string) => `/pages/${pageId}`;
export const pageUrl = (origin: string, pageId: string) => `${origin}${pagePath(pageId)}`;
/** The sandboxed HTML of one version. Served only into a frame. */
export const pageContentPath = (pageId: string, version: number) =>
  `/api/pages/${pageId}/versions/${version}/content`;

/** A page without its HTML: what lists and headers need. */
export interface PageSummary {
  readonly id: string;
  /** Null for a page in no project. */
  readonly projectId: string | null;
  readonly title: string;
  /** The current version: the latest upload. */
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PageVersion {
  readonly version: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: number;
}

/** Where a page is embedded: one tab of one doc. */
export interface PageUse {
  readonly docId: string;
  readonly docTitle: string;
  readonly tabId: string;
  readonly tabTitle: string;
}

/** `GET /api/pages/:id`: the page as one caller may see it. */
export interface PageView extends PageSummary {
  readonly role: DocRole;
  /** False for someone who sees the page only through a doc that embeds it. */
  readonly member: boolean;
  readonly canEdit: boolean;
  readonly versions: ReadonlyArray<PageVersion>;
}

/** One row of `GET /api/pages`. */
export interface PageListItem extends PageSummary {
  readonly role: DocRole;
  readonly bytes: number;
  readonly uses: ReadonlyArray<PageUse>;
}

export interface PageBlock {
  readonly pageId: string;
  /** The frame's height in CSS pixels; null for the default. */
  readonly height: number | null;
  readonly caption: string | null;
}

const HEIGHT_LINE = /^height:\s*(\d{1,5})\s*(?:px)?$/;

/**
 * Reads a block's text: a page id line, an optional `height: <px>` line, then
 * an optional caption line, nothing else.
 */
export function parsePageBlock(body: string): PageBlock | null {
  const lines = body.split("\n").map((line) => line.trim());
  const first = lines[0] ?? "";
  if (!isPageId(first)) return null;
  let at = 1;
  let height: number | null = null;
  const heightMatch = HEIGHT_LINE.exec(lines[at] ?? "");
  if (heightMatch) {
    height = Number(heightMatch[1]);
    if (height < MIN_PAGE_HEIGHT || height > MAX_PAGE_HEIGHT) return null;
    at += 1;
  }
  const caption = lines[at] ?? "";
  if (lines.slice(at + 1).some((line) => line !== "")) return null;
  if (caption.length > MAX_PAGE_CAPTION_LENGTH) return null;
  return { pageId: first, height, caption: caption === "" ? null : caption };
}

/** A block's language, ignoring anything after the first word of the info string. */
export const isPageLanguage = (language: string | null | undefined) =>
  language?.trim().split(/\s+/, 1)[0] === PAGE_LANGUAGE;

/** A whole fenced block, ready to put in a tab's markdown. */
export function pageBlock(pageId: string, caption: string | null = null): string {
  const line = caption?.replace(/\s+/g, " ").trim() ?? "";
  return `\`\`\`${PAGE_LANGUAGE}\n${line ? `${pageId}\n${line}` : pageId}\n\`\`\``;
}

/** The id of every page `markdown` embeds, in order, each once. */
export function pageIdsIn(markdown: string): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const fence of findFences(markdown)) {
    if (fence.language !== PAGE_LANGUAGE) continue;
    const block = parsePageBlock(fence.body);
    if (block) ids.add(block.pageId);
  }
  return [...ids];
}

/**
 * Every block a write adds or changes must parse. A block left byte-identical
 * to `previous` is not re-checked, so older content never blocks an unrelated edit.
 */
export function checkPagesIn(markdown: string, previous?: string): string | null {
  const blocks = findFences(markdown).filter((fence) => fence.language === PAGE_LANGUAGE);
  const unchanged = new Set(
    findFences(previous ?? "")
      .filter((fence) => fence.language === PAGE_LANGUAGE)
      .map((fence) => fence.body),
  );
  for (const [index, fence] of blocks.entries()) {
    if (unchanged.has(fence.body) || parsePageBlock(fence.body)) continue;
    const which = blocks.length === 1 ? "The t3-page block" : `t3-page block ${index + 1}`;
    return (
      `${which}: the first line must be the id of a page. Only an optional ` +
      `"height: <${MIN_PAGE_HEIGHT} to ${MAX_PAGE_HEIGHT}>" line and then a caption ` +
      `of up to ${MAX_PAGE_CAPTION_LENGTH} characters may follow it.`
    );
  }
  return null;
}

const escapeLinkText = (text: string) => text.replace(/([\\[\]])/g, "\\$1");

/** Blocks as markdown links to the page, for downloads. */
export function pagesToLinks(markdown: string, origin: string): string {
  let result = "";
  let at = 0;
  for (const fence of findFences(markdown)) {
    if (fence.language !== PAGE_LANGUAGE) continue;
    const block = parsePageBlock(fence.body);
    if (!block) continue;
    const label = escapeLinkText(block.caption ?? "Interactive page");
    result += `${markdown.slice(at, fence.start)}[${label}](${pageUrl(origin, block.pageId)})`;
    at = fence.end;
  }
  return result + markdown.slice(at);
}

/**
 * Whether bytes look like an HTML document: UTF-8 text whose first tag (after
 * an optional BOM, comments and whitespace) is a doctype or <html>, <head> or
 * <body>. Keeps a renamed binary from becoming a page.
 */
export function looksLikeHtml(text: string): boolean {
  if (text.includes("\u0000")) return false;
  const start = text
    .replace(/^﻿/, "")
    .replace(/^(?:\s|<!--[\s\S]*?-->)*/, "")
    .slice(0, 20)
    .toLowerCase();
  return /^<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/.test(start);
}
