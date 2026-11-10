// A1 addresses: cells (A1, $A$1), ranges (A1:B2), whole columns (C:C), whole
// rows (2:2), open ranges (F2:F) and sheet prefixes (Historical!C:C,
// 'My tab'!A1). Rows and columns are 0-based once parsed.

import { MAX_COLUMNS, MAX_ROWS } from "./types.ts";

/** 0-based column -> letters (0 -> A, 26 -> AA). */
export function columnToLetters(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Letters -> 0-based column, or -1 when not 1-3 letters within MAX_COLUMNS. */
export function lettersToColumn(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n <= MAX_COLUMNS ? n - 1 : -1;
}

export interface CellAddress {
  readonly row: number;
  readonly col: number;
}

/** A rectangle; null bounds are open (start null = from the first, end null = to the last). */
export interface Area {
  readonly startRow: number | null;
  readonly startCol: number | null;
  readonly endRow: number | null;
  readonly endCol: number | null;
}

/** A reference as written in a formula. */
export interface AreaRef extends Area {
  /** Sheet name as written (unquoted), or null for the formula's own sheet. */
  readonly sheet: string | null;
  readonly startRowAbsolute: boolean;
  readonly startColAbsolute: boolean;
  readonly endRowAbsolute: boolean;
  readonly endColAbsolute: boolean;
  /** Written as one cell (A1), not a range. */
  readonly single: boolean;
}

const SHEET_PREFIX = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][A-Za-z0-9_.À-￿]*))!`;
const PART = String.raw`(\$?)([A-Za-z]{1,3})?(\$?)(\d+)?`;
const REF_SOURCE = `(?:${SHEET_PREFIX})?${PART}(?::${PART})?`;

/** Sticky matcher for references inside formula text. */
export const REF_PATTERN = new RegExp(REF_SOURCE, "y");
const REF_WHOLE = new RegExp(`^${REF_SOURCE}$`);

interface Part {
  readonly col: number | null;
  readonly row: number | null;
  readonly colAbs: boolean;
  readonly rowAbs: boolean;
}

function readPart(
  dollarCol: string | undefined,
  letters: string | undefined,
  dollarRow: string | undefined,
  digits: string | undefined,
): Part | null {
  if (letters === undefined && digits === undefined) return null;
  let col: number | null = null;
  let row: number | null = null;
  if (letters !== undefined) {
    col = lettersToColumn(letters);
    if (col < 0) return null;
  } else if (dollarCol) {
    // "$" with no letters belongs to the row: $2 in $2:$3.
    dollarRow = "$";
  }
  if (digits !== undefined) {
    const n = Number(digits);
    if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) return null;
    row = n - 1;
  } else if (dollarRow && letters !== undefined) {
    return null; // "A$" is not an address.
  }
  return {
    col,
    row,
    colAbs: letters !== undefined && dollarCol === "$",
    rowAbs: digits !== undefined && dollarRow === "$",
  };
}

/** Builds an AreaRef from a REF_PATTERN match, or null when the text is not a reference. */
export function refFromMatch(m: RegExpExecArray): AreaRef | null {
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] ?? null);
  const a = readPart(m[3], m[4], m[5], m[6]);
  if (!a) return null;
  const hasEnd = m[7] !== undefined || m[8] !== undefined || m[9] !== undefined || m[10] !== undefined;
  if (!hasEnd) {
    if (a.col === null || a.row === null) return null;
    return {
      sheet,
      startRow: a.row,
      startCol: a.col,
      endRow: a.row,
      endCol: a.col,
      startRowAbsolute: a.rowAbs,
      startColAbsolute: a.colAbs,
      endRowAbsolute: a.rowAbs,
      endColAbsolute: a.colAbs,
      single: true,
    };
  }
  const b = readPart(m[7], m[8], m[9], m[10]);
  if (!b) return null;
  const aCell = a.col !== null && a.row !== null;
  let ref: AreaRef;
  if (aCell && b.col !== null && b.row !== null) {
    ref = makeRange(sheet, a.row, a.col, b.row, b.col, a, b);
  } else if (a.row === null && b.row === null) {
    // C:C
    ref = makeRange(sheet, null, a.col, null, b.col, a, b);
  } else if (a.col === null && b.col === null) {
    // 2:2
    ref = makeRange(sheet, a.row, null, b.row, null, a, b);
  } else if (aCell && b.row === null) {
    // F2:F, open at the bottom.
    ref = makeRange(sheet, a.row, a.col, null, b.col, a, b);
  } else {
    return null;
  }
  return ref;
}

function makeRange(
  sheet: string | null,
  r1: number | null,
  c1: number | null,
  r2: number | null,
  c2: number | null,
  a: Part,
  b: Part,
): AreaRef {
  let [sr, er, srAbs, erAbs] = [r1, r2, a.rowAbs, b.rowAbs];
  if (sr !== null && er !== null && sr > er) [sr, er, srAbs, erAbs] = [er, sr, erAbs, srAbs];
  let [sc, ec, scAbs, ecAbs] = [c1, c2, a.colAbs, b.colAbs];
  if (sc !== null && ec !== null && sc > ec) [sc, ec, scAbs, ecAbs] = [ec, sc, ecAbs, scAbs];
  return {
    sheet,
    startRow: sr,
    startCol: sc,
    endRow: er,
    endCol: ec,
    startRowAbsolute: srAbs,
    startColAbsolute: scAbs,
    endRowAbsolute: erAbs,
    endColAbsolute: ecAbs,
    single: false,
  };
}

/** Parses a whole reference such as "A1", "$A$1:B2", "C:C", "2:2", "F2:F", "'My tab'!A1". */
export function parseRef(text: string): AreaRef | null {
  const m = REF_WHOLE.exec(text.trim());
  return m ? refFromMatch(m as RegExpExecArray) : null;
}

/** Parses a sheet-less A1 range for edits and reads; a single cell is a 1x1 area. */
export function parseArea(text: string): Area | null {
  const ref = typeof text === "string" ? parseRef(text) : null;
  if (!ref || ref.sheet !== null) return null;
  return {
    startRow: ref.startRow,
    startCol: ref.startCol,
    endRow: ref.endRow,
    endCol: ref.endCol,
  };
}

/** Parses a sheet-less single cell such as "B2" or "$B$2". */
export function parseCellAddress(text: string): CellAddress | null {
  const ref = typeof text === "string" ? parseRef(text) : null;
  if (!ref || !ref.single || ref.sheet !== null) return null;
  return { row: ref.startRow as number, col: ref.startCol as number };
}

export function formatCellAddress(row: number, col: number): string {
  return `${columnToLetters(col)}${row + 1}`;
}

/** Formats an area without $ signs, e.g. "A1:B2", "C:C", "2:2", "F2:F", or "A1" when 1x1. */
export function formatArea(area: Area): string {
  return formatRef({
    ...area,
    sheet: null,
    startRowAbsolute: false,
    startColAbsolute: false,
    endRowAbsolute: false,
    endColAbsolute: false,
    single:
      area.startRow !== null &&
      area.startRow === area.endRow &&
      area.startCol !== null &&
      area.startCol === area.endCol,
  });
}

function bound(index: number | null, absolute: boolean, kind: "row" | "col"): string {
  if (index === null) return "";
  const text = kind === "row" ? String(index + 1) : columnToLetters(index);
  return absolute ? `$${text}` : text;
}

export function formatRef(ref: AreaRef): string {
  const prefix = ref.sheet === null ? "" : `${quoteSheetName(ref.sheet)}!`;
  const start =
    bound(ref.startCol, ref.startColAbsolute, "col") + bound(ref.startRow, ref.startRowAbsolute, "row");
  if (ref.single) return prefix + start;
  const end = bound(ref.endCol, ref.endColAbsolute, "col") + bound(ref.endRow, ref.endRowAbsolute, "row");
  return `${prefix}${start}:${end}`;
}

/** Quotes a sheet name when it cannot stand bare before "!". */
export function quoteSheetName(name: string): string {
  const bare =
    /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*$/.test(name) &&
    !/^[A-Za-z]{1,3}\d+$/.test(name) &&
    !/^(TRUE|FALSE)$/i.test(name) &&
    !/^R\d*C\d*$/i.test(name);
  return bare ? name : `'${name.replace(/'/g, "''")}'`;
}

/** Whether (row, col) lies in the area; open bounds are unbounded. */
export function areaContains(area: Area, row: number, col: number): boolean {
  return (
    (area.startRow === null || row >= area.startRow) &&
    (area.endRow === null || row <= area.endRow) &&
    (area.startCol === null || col >= area.startCol) &&
    (area.endCol === null || col <= area.endCol)
  );
}

/** Parses "3" or "3:5" (1-based) into a 0-based inclusive span. */
export function parseRowSpan(spec: number | string): [number, number] | null {
  if (typeof spec === "number") {
    return Number.isInteger(spec) && spec >= 1 && spec <= MAX_ROWS ? [spec - 1, spec - 1] : null;
  }
  if (typeof spec !== "string") return null;
  const m = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(spec);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (a < 1 || b < 1 || a > MAX_ROWS || b > MAX_ROWS) return null;
  return a <= b ? [a - 1, b - 1] : [b - 1, a - 1];
}

/** Parses "C" or "C:E" into a 0-based inclusive span. */
export function parseColumnSpan(spec: string): [number, number] | null {
  if (typeof spec !== "string") return null;
  const m = /^\s*([A-Za-z]{1,3})\s*(?::\s*([A-Za-z]{1,3})\s*)?$/.exec(spec);
  if (!m) return null;
  const a = lettersToColumn(m[1] as string);
  const b = m[2] === undefined ? a : lettersToColumn(m[2]);
  if (a < 0 || b < 0) return null;
  return a <= b ? [a, b] : [b, a];
}
