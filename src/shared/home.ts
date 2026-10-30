// The home page's wire types and the text the Worker derives for it: a short
// preview of each doc's first tab, and search snippets.

import type { AccessibleLibraryProject, LibraryDoc } from "./access.ts";
import { markdownToText } from "./anchors.ts";

/** Characters of text a card preview carries. */
export const PREVIEW_LENGTH = 600;
/** Markdown the Worker reads from the first tab to build a preview; enough for PREVIEW_LENGTH of text. */
export const PREVIEW_SOURCE_LENGTH = 2000;
/** Hits one `GET /api/search` returns at most. */
export const SEARCH_LIMIT = 50;
export const SEARCH_MIN_QUERY = 2;
export const SEARCH_MAX_QUERY = 100;

/** A library doc with what the home page shows on its card. */
export interface HomeDoc extends LibraryDoc {
  /**
   * The start of the first tab as text: one block per line, headings prefixed
   * with "# ". Never more than PREVIEW_LENGTH characters plus an ellipsis.
   */
  readonly preview: string;
  /** People and pending invites on the doc, the caller included. */
  readonly memberCount: number;
  /** When the caller last opened the doc in the app; null if never. */
  readonly openedAt: number | null;
}

export interface HomeProject extends Omit<AccessibleLibraryProject, "docs"> {
  readonly docs: ReadonlyArray<HomeDoc>;
}

/** `GET /api/library`. */
export interface HomeLibrary {
  readonly projects: ReadonlyArray<HomeProject>;
  readonly noProjectDocs: ReadonlyArray<HomeDoc>;
}

/** One tab whose Markdown matches a `GET /api/search?q=` query. */
export interface SearchHit {
  readonly docId: string;
  readonly tabId: string;
  readonly tabTitle: string;
  /** Text around the first match, with an ellipsis where it was cut. */
  readonly snippet: string;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const TABLE_ROW = /^\s*\|/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s*#{1,6}\s+/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const IMAGE_ONLY = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

/**
 * The preview a card shows for a doc: its first tab's prose, skipping code,
 * GFM tables, images and a leading heading that repeats the title. Rich
 * tables and diagrams show what `blockText` gives for them (the Worker passes
 * their cells and labels), and nothing when the head ends inside one.
 */
export function docPreview(
  markdown: string,
  title: string,
  blockText: (language: string, body: string) => ReadonlyArray<string> | null = () => null,
): string {
  const blocks: Array<{ heading: boolean; text: string }> = [];
  let paragraph: Array<string> = [];
  const flush = () => {
    const text = markdownToText(paragraph.join(" ")).replace(/\s+/g, " ").trim();
    if (text) blocks.push({ heading: false, text });
    paragraph = [];
  };
  let fence: { marker: string; language: string; body: Array<string> } | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      if (line.trim().startsWith(fence.marker)) {
        for (const text of blockText(fence.language, fence.body.join("\n")) ?? []) {
          blocks.push({ heading: false, text: text.replace(/\s+/g, " ").trim() });
        }
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening) {
      flush();
      fence = { marker: opening[1]!, language: opening[2] ?? "", body: [] };
      continue;
    }
    if (line.trim() === "" || TABLE_ROW.test(line) || RULE.test(line) || IMAGE_ONLY.test(line)) {
      flush();
      continue;
    }
    if (HEADING.test(line) || LIST_ITEM.test(line)) {
      flush();
      const text = markdownToText(line).replace(/\s+/g, " ").trim();
      if (text) blocks.push({ heading: HEADING.test(line), text });
      continue;
    }
    paragraph.push(line.trim().replace(/^(>\s?)+/, ""));
  }
  flush();

  const first = blocks[0];
  if (first?.heading && first.text.toLowerCase() === title.trim().toLowerCase()) blocks.shift();

  const lines: Array<string> = [];
  let budget = PREVIEW_LENGTH;
  for (const block of blocks) {
    if (budget <= 0) break;
    const text = block.text.length > budget ? `${cutAtWord(block.text, budget)}…` : block.text;
    lines.push(block.heading ? `# ${text}` : text);
    budget -= block.text.length;
  }
  return lines.join("\n");
}

function cutAtWord(text: string, length: number): string {
  const cut = text.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return (space > length * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;

/**
 * Text around the first case-insensitive match of `query` in a tab's visible
 * text, or null when the reader would not see the match anywhere.
 */
export function searchSnippet(visible: string, query: string): string | null {
  const text = visible.replace(/\s+/g, " ").trim();
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return null;
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + query.length + SNIPPET_AFTER);
  let snippet = text.slice(start, end);
  // Trim partial words at the cut edges.
  if (start > 0) snippet = snippet.replace(/^\S*\s/, "");
  if (end < text.length) snippet = snippet.replace(/\s\S*$/, "");
  return `${start > 0 ? "…" : ""}${snippet.trim()}${end < text.length ? "…" : ""}`;
}
