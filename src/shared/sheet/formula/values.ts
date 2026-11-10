// Runtime values of the evaluator: scalars, error values and ranges, with the
// coercions and comparisons Sheets applies.

import { parseNumberText } from "../input.ts";
import { formatGeneral } from "../numberFormat.ts";
import type { ErrorCode, ErrorValue, Scalar, SheetId } from "../types.ts";

const ERRORS = new Map<ErrorCode, ErrorValue>();

/** Shared, frozen error value for a code. */
export function err(code: ErrorCode): ErrorValue {
  let e = ERRORS.get(code);
  if (!e) {
    e = Object.freeze({ error: code });
    ERRORS.set(code, e);
  }
  return e;
}

export function isError(v: unknown): v is ErrorValue {
  return typeof v === "object" && v !== null && "error" in v;
}

/** Reads cells for a range; supplied by the recalc layer. */
export interface CellSource {
  value(sheetId: SheetId, row: number, col: number): Scalar;
  /** Rows and columns in use on a sheet (max filled index + 1). */
  extent(sheetId: SheetId): { readonly rows: number; readonly cols: number };
}

/** A rectangle of cells with concrete bounds (0-based, inclusive). */
export class RangeValue {
  readonly source: CellSource;
  readonly sheetId: SheetId;
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;

  constructor(source: CellSource, sheetId: SheetId, r1: number, c1: number, r2: number, c2: number) {
    this.source = source;
    this.sheetId = sheetId;
    this.r1 = r1;
    this.c1 = c1;
    this.r2 = r2;
    this.c2 = c2;
  }

  get rows(): number {
    return this.r2 - this.r1 + 1;
  }

  get cols(): number {
    return this.c2 - this.c1 + 1;
  }

  get size(): number {
    return this.rows * this.cols;
  }

  /** Value at an offset inside the range. */
  at(i: number, j: number): Scalar {
    return this.source.value(this.sheetId, this.r1 + i, this.c1 + j);
  }

  /** Rows that can hold a value: the range clipped to the sheet's filled extent. */
  get usedRows(): number {
    return Math.max(0, Math.min(this.r2, this.source.extent(this.sheetId).rows - 1) - this.r1 + 1);
  }

  get usedCols(): number {
    return Math.max(0, Math.min(this.c2, this.source.extent(this.sheetId).cols - 1) - this.c1 + 1);
  }

  /** Visits every cell that may hold a value, row by row. Cells beyond are blank. */
  forEachUsed(fn: (v: Scalar, i: number, j: number) => void): void {
    const rows = this.usedRows;
    const cols = this.usedCols;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) fn(this.at(i, j), i, j);
  }
}

export type Value = Scalar | RangeValue;

/** A range in a scalar position: a 1x1 range gives its cell, anything larger is #VALUE!. */
export function toScalar(v: Value): Scalar {
  if (v instanceof RangeValue) return v.size === 1 ? v.at(0, 0) : err("#VALUE!");
  return v;
}

export function toNumber(v: Scalar): number | ErrorValue {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (v.trim() === "") return 0;
    const n = parseNumberText(v);
    return n ? n.value : err("#VALUE!");
  }
  return v;
}

export function toText(v: Scalar): string | ErrorValue {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatGeneral(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v;
}

export function toBoolean(v: Scalar): boolean | ErrorValue {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    if (/^true$/i.test(v.trim())) return true;
    if (/^false$/i.test(v.trim())) return false;
    return err("#VALUE!");
  }
  return v;
}

/** A finite result, or #NUM!; -0 becomes 0. */
export function num(n: number): number | ErrorValue {
  if (!Number.isFinite(n)) return err("#NUM!");
  return n === 0 ? 0 : n;
}

function typeRank(v: number | string | boolean): number {
  return typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
}

/**
 * Orders two non-error scalars as Sheets does: numbers < text < booleans, text
 * case-insensitive. A blank counts as 0, "" or FALSE to match the other side.
 */
export function compareScalars(a: Exclude<Scalar, ErrorValue>, b: Exclude<Scalar, ErrorValue>): number {
  if (a === null && b === null) return 0;
  const x = a === null ? blankLike(b as number | string | boolean) : a;
  const y = b === null ? blankLike(a as number | string | boolean) : b;
  const rx = typeRank(x);
  const ry = typeRank(y);
  if (rx !== ry) return rx - ry;
  if (typeof x === "string") {
    const lx = x.toLowerCase();
    const ly = (y as string).toLowerCase();
    return lx < ly ? -1 : lx > ly ? 1 : 0;
  }
  const nx = Number(x);
  const ny = Number(y);
  return nx < ny ? -1 : nx > ny ? 1 : 0;
}

function blankLike(other: number | string | boolean): number | string | boolean {
  return typeof other === "number" ? 0 : typeof other === "string" ? "" : false;
}

/** Equality for lookups: same type, text case-insensitive; a blank never matches. */
export function lookupEquals(a: Scalar, b: Scalar): boolean {
  if (a === null || b === null || isError(a) || isError(b)) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "string") return a.toLowerCase() === (b as string).toLowerCase();
  return a === b;
}
