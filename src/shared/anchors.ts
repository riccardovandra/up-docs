// Comment anchors: a quote plus a little text on each side, matched against a
// tab's visible text (no markdown syntax, one newline between blocks). The
// editor builds that text from its document; the Worker derives it from the
// tab's markdown, so both sides can locate the same anchor.
//
// Blocks with their own structure (rich tables, diagrams) use a structured
// anchor instead, naming the block and the part by id, so a comment follows
// its cell or label through edits and is orphaned only when that part goes.

import { cellText, findTables, TABLE_LANGUAGE } from "./table.ts";
import { findWidgetFences } from "./widget/fence.ts";
import { analyzeWidget } from "./widget/validate.ts";

export interface DocAnchor {
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
}

export const ANCHOR_CONTEXT_LENGTH = 48;

/** One cell of a ```t3-table block, or one typed label of a diagram block. */
export type StructuredAnchor =
  | {
      readonly kind: "cell";
      readonly blockId: string;
      readonly rowId: string;
      readonly colId: string;
    }
  | { readonly kind: "label"; readonly blockId: string; readonly textId: string };

const ANCHOR_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const anchorId = (value: unknown): value is string =>
  typeof value === "string" && ANCHOR_ID.test(value);

/** Reads a structured anchor from untrusted input (a request body or the stored JSON). */
export function parseStructuredAnchor(value: unknown): StructuredAnchor | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "cell" && anchorId(raw.blockId) && anchorId(raw.rowId) && anchorId(raw.colId)) {
    return { kind: "cell", blockId: raw.blockId, rowId: raw.rowId, colId: raw.colId };
  }
  if (raw.kind === "label" && anchorId(raw.blockId) && anchorId(raw.textId)) {
    return { kind: "label", blockId: raw.blockId, textId: raw.textId };
  }
  return null;
}

/** The part a structured anchor names, with its current words. */
export interface StructuredAnchorTarget {
  readonly kind: StructuredAnchor["kind"];
  readonly text: string;
}

/**
 * Finds the part a structured anchor names in a tab's markdown, or null when
 * the block, row, column or label is gone. Cells resolve by ids alone, so
 * reordering rows or editing other cells never moves a comment.
 */
export function resolveStructuredAnchor(
  markdown: string,
  anchor: StructuredAnchor,
): StructuredAnchorTarget | null {
  if (anchor.kind === "cell") {
    for (const { parsed } of findTables(markdown)) {
      if (!parsed.ok || parsed.table.id !== anchor.blockId) continue;
      const row = parsed.table.rows.find((candidate) => candidate.id === anchor.rowId);
      const column = parsed.table.columns.find((candidate) => candidate.id === anchor.colId);
      if (!row || !column) return null;
      return { kind: "cell", text: cellText(row.cells[column.id]) };
    }
    return null;
  }
  // A diagram label: the ```t3-widget id=<blockId> block's label with that text id.
  for (const fence of findWidgetFences(markdown)) {
    if (fence.id !== anchor.blockId) continue;
    const label = analyzeWidget(fence.source).labels.find((entry) => entry.id === anchor.textId);
    return label ? { kind: "label", text: label.text } : null;
  }
  return null;
}

/**
 * Finds the quote in `text`. With several matches, the one whose surroundings
 * best agree with the stored context wins, so a repeated phrase keeps its place.
 */
export function locateAnchor(
  text: string,
  anchor: DocAnchor,
): { readonly start: number; readonly end: number } | null {
  if (anchor.quote.length === 0) return null;
  let best: { start: number; score: number } | null = null;
  for (
    let start = text.indexOf(anchor.quote);
    start !== -1;
    start = text.indexOf(anchor.quote, start + 1)
  ) {
    const score =
      commonSuffixLength(text.slice(0, start), anchor.prefix) +
      commonPrefixLength(text.slice(start + anchor.quote.length), anchor.suffix);
    if (best === null || score > best.score) best = { start, score };
  }
  if (best !== null) return { start: best.start, end: best.start + anchor.quote.length };
  return locateBetweenContext(text, anchor);
}

// Longest first: a long probe is unambiguous, a short one survives a reworded neighbour.
const CONTEXT_PROBES = [24, 12, 8];

/**
 * The quoted words themselves are often what gets edited (a comment asking for
 * a change gets that change). The text between the unchanged prefix and suffix
 * is then the edited passage, so the comment stays with it.
 */
function locateBetweenContext(
  text: string,
  anchor: DocAnchor,
): { readonly start: number; readonly end: number } | null {
  for (const probe of CONTEXT_PROBES) {
    const located = locateBetweenProbes(text, anchor, probe);
    if (located) return located;
  }
  return null;
}

function locateBetweenProbes(
  text: string,
  anchor: DocAnchor,
  probe: number,
): { readonly start: number; readonly end: number } | null {
  const before = anchor.prefix.slice(-probe);
  const after = anchor.suffix.slice(0, probe);
  if (before.length < Math.min(probe, 8) || after.length < Math.min(probe, 8)) return null;
  const maxLength = anchor.quote.length * 2 + 80;
  let best: { start: number; end: number } | null = null;
  for (let at = text.indexOf(before); at !== -1; at = text.indexOf(before, at + 1)) {
    const start = at + before.length;
    const end = text.indexOf(after, start);
    if (end <= start || end - start > maxLength) continue;
    const distance = Math.abs(end - start - anchor.quote.length);
    if (best === null || distance < Math.abs(best.end - best.start - anchor.quote.length)) {
      best = { start, end };
    }
  }
  if (best === null) return null;
  // Trim the separators the context did not include so the range starts and ends on text.
  while (best.start < best.end && /\s/.test(text[best.start]!)) {
    best = { ...best, start: best.start + 1 };
  }
  while (best.end > best.start && /\s/.test(text[best.end - 1]!)) {
    best = { ...best, end: best.end - 1 };
  }
  return best.start === best.end ? null : best;
}

/** The anchor for `text[start..end]`, with surrounding context. */
export function anchorAt(text: string, start: number, end: number): DocAnchor {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT_LENGTH),
  };
}

export type QuoteMatch =
  | { readonly kind: "found"; readonly anchor: DocAnchor }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly count: number };

/**
 * Anchors a quote an agent copied from a tab's markdown. Markdown syntax in the
 * quote is ignored, and the quote must appear exactly once in the visible text.
 */
export function findQuote(text: string, quote: string): QuoteMatch {
  const needle = markdownToText(quote);
  if (needle.length === 0) return { kind: "missing" };
  const starts: Array<number> = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    starts.push(at);
  }
  if (starts.length === 0) return { kind: "missing" };
  if (starts.length > 1) return { kind: "ambiguous", count: starts.length };
  return { kind: "found", anchor: anchorAt(text, starts[0]!, starts[0]! + needle.length) };
}

/**
 * The visible text of a tab's markdown, matching what the editor shows: block
 * syntax and inline markers removed, one newline between blocks, table cells
 * as separate blocks. Approximate for exotic markdown, which only makes an
 * anchor read as removed on the server while the editor still finds it.
 */
export function markdownToText(markdown: string): string {
  const lines: Array<string> = [];
  let fence: string | null = null;
  // Rich table bodies are JSON; their cells are commented through cell anchors.
  let hidden = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      if (raw.trim().startsWith(fence)) fence = null;
      else if (!hidden) lines.push(raw);
      continue;
    }
    const opening = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(raw);
    if (opening) {
      fence = opening[1]!;
      hidden = opening[2] === TABLE_LANGUAGE;
      continue;
    }
    const line = raw.trim();
    if (line === "" || /^([-*_])(\s*\1){2,}$/.test(line)) continue;
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line)) continue;
    if (line.startsWith("|")) {
      for (const cell of line.replace(/^\|/, "").replace(/\|$/, "").split("|")) {
        const text = inlineText(cell.trim());
        if (text) lines.push(text);
      }
      continue;
    }
    const block = line
      .replace(/^(>\s?)+/, "")
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/\s+#+$/, "");
    const text = inlineText(block);
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

const ESCAPE_BASE = 0xe000;

function inlineText(source: string): string {
  // Escaped punctuation is parked in the private use area so the marker
  // patterns below cannot consume it, then restored.
  return source
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, char: string) =>
      String.fromCharCode(ESCAPE_BASE + char.charCodeAt(0)),
    )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(`+)([^`]*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/\*(?=\S)(.*?\S)\*/g, "$1")
    .replace(/(^|[^\w])_(?=\S)(.*?\S)_(?!\w)/g, "$1$2")
    .replace(/[-]/g, (char) => String.fromCharCode(char.charCodeAt(0) - ESCAPE_BASE))
    .replace(/(\\|\s{2,})$/, "");
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

function commonSuffixLength(a: string, b: string): number {
  let length = 0;
  while (
    length < a.length &&
    length < b.length &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}
