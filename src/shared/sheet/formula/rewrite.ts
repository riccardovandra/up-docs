// Rewrites references inside formula text, keeping everything else as typed.
// Used when rows or columns are inserted or deleted (references shift, a
// deleted target becomes #REF!), sheets are renamed or deleted, and sorted
// rows carry their formulas (relative references move with the row).

import { formatRef, type AreaRef } from "../address.ts";
import { MAX_COLUMNS, MAX_ROWS } from "../types.ts";
import { tokenize } from "./tokenizer.ts";

/** New reference, "#REF!" to replace it with an error, or null to keep it. */
export type RefRewrite = (ref: AreaRef) => AreaRef | "#REF!" | null;

/** Returns the rewritten formula, or null when no reference changed. */
export function rewriteFormula(formula: string, fn: RefRewrite): string | null {
  if (!formula.startsWith("=")) return null;
  const tokens = tokenize(formula.slice(1));
  let out = "";
  let changed = false;
  for (const t of tokens) {
    if (t.type !== "ref" || !t.ref) {
      out += t.text;
      continue;
    }
    const r = fn(t.ref);
    if (r === null) out += t.text;
    else {
      changed = true;
      out += r === "#REF!" ? "#REF!" : formatRef(r);
    }
  }
  return changed ? `=${out}` : null;
}

export type Axis = "row" | "col";

function limit(axis: Axis): number {
  return axis === "row" ? MAX_ROWS - 1 : MAX_COLUMNS - 1;
}

function get(ref: AreaRef, axis: Axis): [number | null, number | null] {
  return axis === "row" ? [ref.startRow, ref.endRow] : [ref.startCol, ref.endCol];
}

function set(ref: AreaRef, axis: Axis, start: number | null, end: number | null): AreaRef {
  return axis === "row" ? { ...ref, startRow: start, endRow: end } : { ...ref, startCol: start, endCol: end };
}

/** `count` rows/columns inserted before index `at`: bounds at or after it move down/right. */
export function shiftForInsert(ref: AreaRef, axis: Axis, at: number, count: number): AreaRef | "#REF!" | null {
  const [s, e] = get(ref, axis);
  const ns = s !== null && s >= at ? s + count : s;
  const ne = e !== null && e >= at ? e + count : e;
  if (ns === s && ne === e) return null;
  if ((ns ?? 0) > limit(axis) || (ne ?? 0) > limit(axis)) return "#REF!";
  return set(ref, axis, ns, ne);
}

/** `count` rows/columns deleted from index `from`: a fully deleted target becomes #REF!, ranges shrink. */
export function shiftForDelete(ref: AreaRef, axis: Axis, from: number, count: number): AreaRef | "#REF!" | null {
  const [s, e] = get(ref, axis);
  const to = from + count; // exclusive
  if (ref.single) {
    const i = s as number;
    if (i < from) return null;
    if (i < to) return "#REF!";
    return set(ref, axis, i - count, i - count);
  }
  const ns = s === null ? null : s < from ? s : s >= to ? s - count : from;
  const ne = e === null ? null : e < from ? e : e >= to ? e - count : from - 1;
  if (ns !== null && ne !== null && ns > ne) return "#REF!";
  if (ns === s && ne === e) return null;
  return set(ref, axis, ns, ne);
}

/** Moves the relative bounds on an axis by `delta`, as copying a formula does. */
export function offsetRelative(ref: AreaRef, axis: Axis, delta: number): AreaRef | "#REF!" | null {
  if (delta === 0) return null;
  const [s, e] = get(ref, axis);
  const [sAbs, eAbs] = axis === "row" ? [ref.startRowAbsolute, ref.endRowAbsolute] : [ref.startColAbsolute, ref.endColAbsolute];
  const ns = s === null || sAbs ? s : s + delta;
  const ne = e === null || eAbs ? e : e + delta;
  if (ns === s && ne === e) return null;
  if ((ns !== null && (ns < 0 || ns > limit(axis))) || (ne !== null && (ne < 0 || ne > limit(axis)))) return "#REF!";
  if (ns !== null && ne !== null && ns > ne) return set(ref, axis, ne, ns);
  return set(ref, axis, ns, ne);
}
