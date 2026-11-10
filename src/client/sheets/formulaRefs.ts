// References inside a formula being typed: their colours in the formula bar
// and outlines on the grid, and "point mode", where clicking or arrowing to a
// cell while typing a formula inserts its reference at the caret.

import { formatArea, quoteSheetName, type AreaRef } from "../../shared/sheet/address.ts";
import { tokenize } from "../../shared/sheet/formula/tokenizer.ts";
import type { Dims, Rect } from "./selection.ts";

/** Reference colours, in order of first appearance, as Sheets cycles them. */
export const REF_COLORS = [
  "#1a73e8",
  "#e8710a",
  "#9334e6",
  "#188038",
  "#d01884",
  "#12a4af",
  "#c5221f",
  "#7e5700",
] as const;

export interface RefSpan {
  /** Offsets in the whole input, "=" included. */
  readonly start: number;
  readonly end: number;
  readonly ref: AreaRef;
  readonly color: string;
}

/** Every reference in a formula with its colour; the same reference shares one. */
export function formulaRefSpans(input: string): ReadonlyArray<RefSpan> {
  if (!input.startsWith("=")) return [];
  const colors = new Map<string, string>();
  const spans: RefSpan[] = [];
  for (const token of tokenize(input.slice(1))) {
    if (token.type !== "ref" || !token.ref) continue;
    const key = token.text.replace(/\$/g, "").toUpperCase();
    let color = colors.get(key);
    if (!color) {
      color = REF_COLORS[colors.size % REF_COLORS.length] as string;
      colors.set(key, color);
    }
    spans.push({ start: token.start + 1, end: token.end + 1, ref: token.ref, color });
  }
  return spans;
}

/**
 * The outline a reference draws on the tab shown, or null when it points at
 * another tab. Open ends (C:C, 2:2, F2:F) run to the tab's edge.
 */
export function refRect(
  ref: AreaRef,
  shownSheet: string,
  formulaSheet: string,
  dims: Dims,
): Rect | null {
  const target = ref.sheet ?? formulaSheet;
  if (target.toLowerCase() !== shownSheet.toLowerCase()) return null;
  const r1 = ref.startRow ?? 0;
  const c1 = ref.startCol ?? 0;
  const r2 = ref.endRow ?? dims.rows - 1;
  const c2 = ref.endCol ?? dims.cols - 1;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

/** After one of these, a reference may follow. */
const BEFORE_REF = new Set(["=", "(", ",", "+", "-", "*", "/", "^", "&", "<", ">", ":"]);

/** The span of input a picked reference replaces, held while pointing. */
export interface PointSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Where a picked reference goes: over the reference picked just before (still
 * at the caret), or at the caret when it follows an operator, "(" or ",".
 * Null when the caret is not at such a place, or the input is not a formula.
 */
export function refInsertion(
  input: string,
  caret: number,
  pointing: PointSpan | null,
): PointSpan | null {
  if (!input.startsWith("=")) return null;
  if (pointing && pointing.end === caret && pointing.start < caret) return pointing;
  let at = caret - 1;
  while (at >= 0 && input[at] === " ") at -= 1;
  if (at < 0) return null;
  if (!BEFORE_REF.has(input[at] as string)) return null;
  // The caret must not sit inside a word: "=A|1" is not a place for a reference.
  const after = input[caret];
  if (after !== undefined && /[A-Za-z0-9_$.!']/.test(after)) return null;
  return { start: caret, end: caret };
}

/** A1 text for a picked rectangle, prefixed with its tab when that is not the formula's own. */
export function pickedRefText(rect: Rect, pickedSheet: string, formulaSheet: string): string {
  const area = formatArea({ startRow: rect.r1, startCol: rect.c1, endRow: rect.r2, endCol: rect.c2 });
  return pickedSheet.toLowerCase() === formulaSheet.toLowerCase()
    ? area
    : `${quoteSheetName(pickedSheet)}!${area}`;
}

/** `input` with `text` put over `span`; returns the new input and the span it now fills. */
export function putRef(
  input: string,
  span: PointSpan,
  text: string,
): { readonly input: string; readonly span: PointSpan } {
  return {
    input: input.slice(0, span.start) + text + input.slice(span.end),
    span: { start: span.start, end: span.start + text.length },
  };
}
