// Workbook operations: create, apply edit lists, read cells and sheets.
// `applyEdits` checks `base` against the revision, applies every edit in order
// on a copy-on-write draft and either returns the new workbook (revision + 1)
// with what changed, or a refusal naming the edit that failed. The input
// workbook is never mutated, so a refusal leaves nothing half-applied.

import {
  formatArea,
  lettersToColumn,
  parseArea,
  parseCellAddress,
  parseColumnSpan,
  parseRowSpan,
  type AreaRef,
} from "./address.ts";
import { isoDate, isoDateTime, isoTime } from "./dates.ts";
import { offsetRelative, rewriteFormula, shiftForDelete, shiftForInsert, type Axis } from "./formula/rewrite.ts";
import { compareScalars, isError } from "./formula/values.ts";
import { inputFromValue, parseInput } from "./input.ts";
import { display, patternKind } from "./numberFormat.ts";
import { computeAll, recalcChanged, resolveOptions, sameComputed } from "./recalc.ts";
import {
  DEFAULT_COLUMN_COUNT,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_COUNT,
  DEFAULT_ROW_HEIGHT,
  MAX_CELLS_PER_EDIT_LIST,
  MAX_CELLS_PER_READ,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_SHEET_NAME_LENGTH,
  MAX_WORKBOOK_CELLS,
  cellKey,
  keyCol,
  keyRow,
  type Applied,
  type Calc,
  type Cell,
  type CellFormat,
  type CellPosition,
  type CellRead,
  type CellsRead,
  type Computed,
  type Edit,
  type EngineOptions,
  type FormatPatch,
  type Refusal,
  type RefusalName,
  type Scalar,
  type Sheet,
  type SheetId,
  type SheetSettings,
  type SheetsRead,
  type Workbook,
} from "./types.ts";

export const DEFAULT_SETTINGS: SheetSettings = {
  lastFrozenRow: 0,
  lastFrozenColumn: 0,
  areGridlinesHidden: false,
};

export function isRefusal(x: unknown): x is Refusal {
  return typeof x === "object" && x !== null && "refusal" in x;
}

/** An empty sheet with default size and settings. */
export function emptySheet(id: SheetId, name: string): Sheet {
  return {
    id,
    name,
    rowCount: DEFAULT_ROW_COUNT,
    columnCount: DEFAULT_COLUMN_COUNT,
    settings: DEFAULT_SETTINGS,
    columnWidths: {},
    rowHeights: {},
    cells: new Map(),
  };
}

/** A new workbook at revision 0 with one empty sheet (id "s0-0"). */
export function createWorkbook(options: EngineOptions & { readonly sheetName?: string } = {}): Workbook {
  const sheets = [emptySheet("s0-0", options.sheetName ?? "Sheet1")];
  return { revision: 0, sheets, calc: computeAll(sheets, resolveOptions(options)) };
}

/** Builds a workbook (and computes it) from sheets, e.g. loaded from storage. */
export function workbookFromSheets(revision: number, sheets: ReadonlyArray<Sheet>, options: EngineOptions = {}): Workbook {
  return { revision, sheets, calc: computeAll(sheets, resolveOptions(options)) };
}

/** Re-evaluates every formula, e.g. to refresh TODAY/NOW; the revision is unchanged. */
export function recalculate(workbook: Workbook): Workbook {
  return { ...workbook, calc: computeAll(workbook.sheets, workbook.calc.options) };
}

/** Finds a sheet by id, else by name (case-insensitive). */
export function findSheet(workbook: Pick<Workbook, "sheets">, ref: string): Sheet | undefined {
  if (typeof ref !== "string") return undefined;
  return (
    workbook.sheets.find((s) => s.id === ref) ??
    workbook.sheets.find((s) => s.name.toLowerCase() === ref.toLowerCase())
  );
}

// ---- Draft ----

class Refuse extends Error {
  readonly refusal: RefusalName;
  readonly detail: string;

  constructor(refusal: RefusalName, detail: string) {
    super(detail);
    this.refusal = refusal;
    this.detail = detail;
  }
}

interface MutableSheet {
  id: SheetId;
  name: string;
  rowCount: number;
  columnCount: number;
  settings: SheetSettings;
  columnWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  cells: Map<number, Cell>;
}

class Draft {
  sheets: MutableSheet[];
  readonly revision: number;
  calc: Calc;
  cellCount: number;
  private readonly ownCells = new Set<SheetId>();
  // Since the last settle.
  private pending = new Map<SheetId, Set<number>>();
  private structural = false;
  // Reported.
  readonly changedCells = new Map<SheetId, Set<number>>();
  readonly rebuilt = new Set<SheetId>();
  readonly meta = new Set<SheetId>();
  readonly added = new Set<SheetId>();
  readonly deleted = new Set<SheetId>();
  private readonly valueChanges = new Map<SheetId, Set<number>>();
  private fullRecompute = false;
  anyChange = false;

  readonly base: Workbook;

  constructor(base: Workbook) {
    this.base = base;
    this.revision = base.revision + 1;
    this.calc = base.calc;
    this.sheets = base.sheets.map((s) => ({
      ...s,
      columnWidths: { ...s.columnWidths },
      rowHeights: { ...s.rowHeights },
      cells: s.cells as Map<number, Cell>,
    }));
    this.cellCount = base.sheets.reduce((n, s) => n + s.cells.size, 0);
  }

  sheet(ref: unknown, field = "sheet"): MutableSheet {
    if (typeof ref !== "string") throw new Refuse("badEdit", `${field} must be a sheet name or id`);
    const s =
      this.sheets.find((x) => x.id === ref) ?? this.sheets.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!s) throw new Refuse("unknownSheet", `No sheet named ${JSON.stringify(ref)}`);
    return s;
  }

  cells(sheet: MutableSheet): Map<number, Cell> {
    if (!this.ownCells.has(sheet.id)) {
      sheet.cells = new Map(sheet.cells);
      this.ownCells.add(sheet.id);
    }
    return sheet.cells;
  }

  /** Replaces all cells of a sheet (rows/columns moved). */
  replaceCells(sheet: MutableSheet, cells: Map<number, Cell>): void {
    sheet.cells = cells;
    this.ownCells.add(sheet.id);
    this.rebuilt.add(sheet.id);
    this.structural = true;
    this.anyChange = true;
  }

  /** Sets or deletes one cell; returns whether anything changed. */
  setCell(sheet: MutableSheet, key: number, cell: Cell | undefined): boolean {
    const before = sheet.cells.get(key);
    if (sameCell(before, cell)) return false;
    const cells = this.cells(sheet);
    if (cell) cells.set(key, cell);
    else cells.delete(key);
    this.cellCount += (cell ? 1 : 0) - (before ? 1 : 0);
    addTo(this.pending, sheet.id, key);
    addTo(this.changedCells, sheet.id, key);
    this.anyChange = true;
    return true;
  }

  markMeta(sheet: MutableSheet): void {
    this.meta.add(sheet.id);
    this.anyChange = true;
  }

  markStructural(): void {
    this.structural = true;
  }

  /** Brings computed values up to date with the edits so far. */
  settle(): void {
    if (this.structural) {
      this.calc = computeAll(this.sheets, this.calc.options);
      this.fullRecompute = true;
    } else {
      // Always runs: TODAY/NOW refresh on every accepted edit list, even metadata-only ones.
      const changed: Array<{ sheetId: SheetId; key: number }> = [];
      for (const [sheetId, keys] of this.pending) for (const key of keys) changed.push({ sheetId, key });
      const r = recalcChanged(this.calc, this.sheets, changed);
      this.calc = r.calc;
      for (const c of r.changed) addTo(this.valueChanges, c.sheetId, c.key);
    }
    this.pending = new Map();
    this.structural = false;
  }

  /** Every formula cell on every sheet, rewritten by `fn` (owner sheet id given for bare references). */
  rewriteFormulas(fn: (ref: AreaRef, owner: SheetId) => AreaRef | "#REF!" | null): void {
    for (const sheet of this.sheets) {
      for (const [key, cell] of sheet.cells) {
        if (!cell.input.startsWith("=") || cell.input.length < 2) continue;
        const next = rewriteFormula(cell.input, (ref) => fn(ref, sheet.id));
        if (next !== null) this.setCell(sheet, key, { ...cell, input: next });
      }
    }
  }

  /** Sheet id a reference points at, using current names. */
  targetOf(ref: AreaRef, owner: SheetId): SheetId | null {
    if (ref.sheet === null) return owner;
    const lower = ref.sheet.toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === lower)?.id ?? null;
  }

  finish(): Applied {
    this.settle();
    const sheets: Sheet[] = this.sheets;
    const workbook: Workbook = { revision: this.revision, sheets, calc: this.calc };
    const live = new Set(sheets.map((s) => s.id));
    const keep = (id: SheetId) => live.has(id) && !this.rebuilt.has(id);
    const cells: CellPosition[] = [];
    for (const [sheetId, keys] of this.changedCells) {
      if (!keep(sheetId) || this.added.has(sheetId)) continue;
      for (const key of keys) cells.push({ sheetId, row: keyRow(key), col: keyCol(key) });
    }
    const values: CellPosition[] = [];
    if (this.fullRecompute) {
      for (const s of sheets) {
        if (!keep(s.id) || this.added.has(s.id)) continue;
        const before = this.base.calc.values.get(s.id) ?? new Map<number, Computed>();
        const after = this.calc.values.get(s.id) ?? new Map<number, Computed>();
        const keys = new Set([...before.keys(), ...after.keys()]);
        for (const key of keys) {
          if (!sameComputed(before.get(key), after.get(key))) values.push({ sheetId: s.id, row: keyRow(key), col: keyCol(key) });
        }
      }
    } else {
      for (const [sheetId, keys] of this.valueChanges) {
        if (!keep(sheetId)) continue;
        for (const key of keys) values.push({ sheetId, row: keyRow(key), col: keyCol(key) });
      }
    }
    // Added sheets are reported whole.
    const rebuiltSheets = sheets.filter((s) => this.rebuilt.has(s.id) || this.added.has(s.id)).map((s) => s.id);
    return {
      workbook,
      revision: this.revision,
      changed: {
        cells,
        rebuiltSheets,
        sheets: sheets.filter((s) => this.meta.has(s.id) || this.added.has(s.id)).map((s) => s.id),
        deletedSheets: [...this.deleted],
        values,
      },
    };
  }
}

function addTo(map: Map<SheetId, Set<number>>, id: SheetId, key: number): void {
  let set = map.get(id);
  if (!set) map.set(id, (set = new Set()));
  set.add(key);
}

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a || !b) return a === b;
  return a.input === b.input && JSON.stringify(a.format ?? null) === JSON.stringify(b.format ?? null);
}

// ---- validation helpers ----

function isInt(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

function requireInt(n: unknown, min: number, max: number, field: string, name: RefusalName = "badEdit"): number {
  if (!isInt(n, min, max)) throw new Refuse(name, `${field} must be a whole number from ${min} to ${max}`);
  return n;
}

function validName(name: unknown): string {
  if (typeof name !== "string") throw new Refuse("badName", "name must be text");
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > MAX_SHEET_NAME_LENGTH || /[\u0000-\u001f]/.test(trimmed)) {
    throw new Refuse("badName", `A sheet name is 1 to ${MAX_SHEET_NAME_LENGTH} characters without control characters`);
  }
  return trimmed;
}

/** 0-based row indices from row specs, all below rowCount. */
function rowIndices(specs: unknown, rowCount: number, field = "rows"): number[] {
  if (!Array.isArray(specs) || specs.length === 0) throw new Refuse("badEdit", `${field} must be a non-empty list`);
  const out = new Set<number>();
  for (const spec of specs) {
    const span = parseRowSpan(spec as number | string);
    if (!span) throw new Refuse("badRange", `Bad row ${JSON.stringify(spec)}`);
    if (span[1] >= rowCount) throw new Refuse("badRange", `Row ${span[1] + 1} is past the sheet's ${rowCount} rows`);
    for (let r = span[0]; r <= span[1]; r++) out.add(r);
  }
  return [...out].sort((a, b) => a - b);
}

function columnIndices(specs: unknown, columnCount: number, field = "columns"): number[] {
  if (!Array.isArray(specs) || specs.length === 0) throw new Refuse("badEdit", `${field} must be a non-empty list`);
  const out = new Set<number>();
  for (const spec of specs) {
    const span = parseColumnSpan(spec as string);
    if (!span) throw new Refuse("badRange", `Bad column ${JSON.stringify(spec)}`);
    if (span[1] >= columnCount) throw new Refuse("badRange", `Column ${spec} is past the sheet's ${columnCount} columns`);
    for (let c = span[0]; c <= span[1]; c++) out.add(c);
  }
  return [...out].sort((a, b) => a - b);
}

/** Contiguous blocks [start, count], highest first. */
function blocksDescending(indices: ReadonlyArray<number>): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  for (const i of indices) {
    const last = blocks[blocks.length - 1];
    if (last && last[0] + last[1] === i) last[1]++;
    else blocks.push([i, 1]);
  }
  return blocks.reverse();
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

function checkPatch(format: unknown): FormatPatch {
  const bad = (what: string): never => {
    throw new Refuse("badEdit", `format.${what}`);
  };
  if (typeof format !== "object" || format === null || Array.isArray(format)) bad("must be an object");
  const f = format as Record<string, unknown>;
  for (const key of Object.keys(f)) {
    if (!["numberFormat", "alignment", "fillColor", "font"].includes(key)) bad(`${key} is not a format key`);
  }
  const obj = (v: unknown, name: string, keys: string[]) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "object" || Array.isArray(v)) bad(`${name} must be an object or null`);
    for (const k of Object.keys(v as object)) if (!keys.includes(k)) bad(`${name}.${k} is not a format key`);
  };
  obj(f.numberFormat, "numberFormat", ["pattern"]);
  if (f.numberFormat && typeof (f.numberFormat as { pattern?: unknown }).pattern !== "string") {
    bad("numberFormat.pattern must be text");
  }
  obj(f.alignment, "alignment", ["horizontal", "wrap"]);
  const al = f.alignment as Record<string, unknown> | null | undefined;
  if (al?.horizontal != null && !["left", "center", "right"].includes(al.horizontal as string)) {
    bad("alignment.horizontal must be left, center or right");
  }
  if (al?.wrap != null && typeof al.wrap !== "boolean") bad("alignment.wrap must be true or false");
  if (f.fillColor != null && !(typeof f.fillColor === "string" && COLOR.test(f.fillColor))) {
    bad("fillColor must be #rrggbb");
  }
  obj(f.font, "font", ["bold", "italic", "underline", "strikethrough", "color", "size"]);
  const font = f.font as Record<string, unknown> | null | undefined;
  for (const k of ["bold", "italic", "underline", "strikethrough"]) {
    if (font?.[k] != null && typeof font[k] !== "boolean") bad(`font.${k} must be true or false`);
  }
  if (font?.color != null && !(typeof font.color === "string" && COLOR.test(font.color))) {
    bad("font.color must be #rrggbb");
  }
  if (font?.size != null && !isInt(font.size, 6, 72)) bad("font.size must be a whole number from 6 to 72");
  return f as FormatPatch;
}

function mergeGroup<T extends object>(
  current: T | undefined,
  patch: Record<string, unknown> | null | undefined,
): T | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  const out: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Applies a format patch; returns undefined when no format is left. */
export function mergeFormat(current: CellFormat | undefined, patch: FormatPatch): CellFormat | undefined {
  const next: {
    numberFormat?: CellFormat["numberFormat"];
    alignment?: CellFormat["alignment"];
    fillColor?: string;
    font?: CellFormat["font"];
  } = {};
  const numberFormat =
    patch.numberFormat === undefined
      ? current?.numberFormat
      : patch.numberFormat === null
        ? undefined
        : { pattern: patch.numberFormat.pattern };
  if (numberFormat) next.numberFormat = numberFormat;
  const alignment = mergeGroup<NonNullable<CellFormat["alignment"]>>(current?.alignment, patch.alignment);
  if (alignment) next.alignment = alignment;
  const fill = patch.fillColor === undefined ? current?.fillColor : (patch.fillColor ?? undefined);
  if (fill) next.fillColor = fill;
  const font = mergeGroup<NonNullable<CellFormat["font"]>>(current?.font, patch.font);
  if (font) next.font = font;
  return Object.keys(next).length ? (next as CellFormat) : undefined;
}

/** The cell after typing `input` (null clears) into `existing`. A typed %, $, €, comma or date sets the number format. */
export function typedCell(existing: Cell | undefined, input: string | null): Cell | undefined {
  if (input === null) return existing?.format ? { input: "", format: existing.format } : undefined;
  let format = existing?.format;
  const parsed = parseInput(input);
  if (parsed.kind === "number" && parsed.pattern) format = { ...format, numberFormat: { pattern: parsed.pattern } };
  return format ? { input, format } : { input };
}

// ---- edits ----

function grow(draft: Draft, sheet: MutableSheet, row: number, col: number): void {
  if (row >= MAX_ROWS || col >= MAX_COLUMNS) throw new Refuse("badRange", "Past the largest sheet size");
  if (row >= sheet.rowCount) {
    sheet.rowCount = row + 1;
    draft.markMeta(sheet);
    draft.markStructural(); // open ranges (A:A, F2:F) grow with the sheet
  }
  if (col >= sheet.columnCount) {
    sheet.columnCount = col + 1;
    draft.markMeta(sheet);
    draft.markStructural();
  }
}

function writeCells(draft: Draft, e: Extract<Edit, { kind: "writeCells" }>): void {
  const sheet = draft.sheet(e.sheet);
  const tl = parseCellAddress(e.topLeft);
  if (!tl) throw new Refuse("badRange", `topLeft must be one cell like "A1", got ${JSON.stringify(e.topLeft)}`);
  if (!Array.isArray(e.rows)) throw new Refuse("badEdit", "rows must be a list of lists");
  e.rows.forEach((row, i) => {
    if (!Array.isArray(row)) throw new Refuse("badEdit", `rows[${i}] must be a list`);
    row.forEach((v, j) => {
      const input = inputFromValue(v);
      if (input === undefined) throw new Refuse("badEdit", `rows[${i}][${j}] must be text, a number, true/false or null`);
      const r = tl.row + i;
      const c = tl.col + j;
      if (input !== null) grow(draft, sheet, r, c);
      else if (r >= sheet.rowCount || c >= sheet.columnCount) return;
      const key = cellKey(r, c);
      draft.setCell(sheet, key, typedCell(sheet.cells.get(key), input));
    });
  });
}

function formatCells(draft: Draft, e: Extract<Edit, { kind: "formatCells" }>): void {
  const sheet = draft.sheet(e.sheet);
  if (!Array.isArray(e.ranges) || e.ranges.length === 0) throw new Refuse("badEdit", "ranges must be a non-empty list");
  const patch = checkPatch(e.format);
  for (const text of e.ranges) {
    const area = parseArea(text);
    if (!area) throw new Refuse("badRange", `Bad range ${JSON.stringify(text)}`);
    const r1 = area.startRow ?? 0;
    const c1 = area.startCol ?? 0;
    const r2 = area.endRow ?? sheet.rowCount - 1;
    const c2 = area.endCol ?? sheet.columnCount - 1;
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_WORKBOOK_CELLS) throw new Refuse("workbookFull", `${text} is too large to format`);
    grow(draft, sheet, r2, c2);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const key = cellKey(r, c);
        const existing = sheet.cells.get(key);
        const format = mergeFormat(existing?.format, patch);
        const input = existing?.input ?? "";
        draft.setCell(sheet, key, format ? { input, format } : input ? { input } : undefined);
      }
      if (draft.cellCount > MAX_WORKBOOK_CELLS) throw new Refuse("workbookFull", `More than ${MAX_WORKBOOK_CELLS} filled cells`);
    }
  }
}

function addSheet(draft: Draft, e: Extract<Edit, { kind: "addSheet" }>, editIndex: number): void {
  const name = validName(e.name);
  if (draft.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw new Refuse("sheetNameTaken", `A sheet named ${JSON.stringify(name)} exists`);
  }
  let id = `s${draft.revision}-${editIndex}`;
  while (draft.sheets.some((s) => s.id === id)) id += "x";
  const sheet: MutableSheet = { ...emptySheet(id, name), columnWidths: {}, rowHeights: {}, cells: new Map() };
  draft.sheets.push(sheet);
  draft.cells(sheet);
  draft.added.add(id);
  draft.markMeta(sheet);
  draft.markStructural();
}

function renameSheet(draft: Draft, e: Extract<Edit, { kind: "renameSheet" }>): void {
  const sheet = draft.sheet(e.sheet);
  const name = validName(e.name);
  if (name === sheet.name) return;
  if (draft.sheets.some((s) => s !== sheet && s.name.toLowerCase() === name.toLowerCase())) {
    throw new Refuse("sheetNameTaken", `A sheet named ${JSON.stringify(name)} exists`);
  }
  draft.rewriteFormulas((ref, owner) =>
    ref.sheet !== null && draft.targetOf(ref, owner) === sheet.id ? { ...ref, sheet: name } : null,
  );
  sheet.name = name;
  draft.markMeta(sheet);
  draft.markStructural();
}

function deleteSheet(draft: Draft, e: Extract<Edit, { kind: "deleteSheet" }>): void {
  const sheet = draft.sheet(e.sheet);
  if (draft.sheets.length === 1) throw new Refuse("lastSheet", "A workbook keeps at least one sheet");
  draft.rewriteFormulas((ref, owner) =>
    ref.sheet !== null && owner !== sheet.id && draft.targetOf(ref, owner) === sheet.id ? "#REF!" : null,
  );
  const position = draft.sheets.indexOf(sheet);
  draft.sheets = draft.sheets.filter((s) => s !== sheet);
  // Later tabs move up one position.
  for (const s of draft.sheets.slice(position)) draft.markMeta(s);
  draft.cellCount -= sheet.cells.size;
  if (draft.added.has(sheet.id)) draft.added.delete(sheet.id);
  else draft.deleted.add(sheet.id);
  draft.meta.delete(sheet.id);
  draft.anyChange = true;
  draft.markStructural();
}

function moveSheets(draft: Draft, e: Extract<Edit, { kind: "moveSheets" }>): void {
  if (!Array.isArray(e.sheets) || e.sheets.length === 0) throw new Refuse("badEdit", "sheets must be a non-empty list");
  const moving = e.sheets.map((ref) => draft.sheet(ref, "sheets"));
  if (new Set(moving).size !== moving.length) throw new Refuse("badEdit", "sheets lists a sheet twice");
  const after = e.afterSheet === null || e.afterSheet === undefined ? null : draft.sheet(e.afterSheet, "afterSheet");
  if (after && moving.includes(after)) throw new Refuse("badEdit", "afterSheet is one of the sheets being moved");
  const rest = draft.sheets.filter((s) => !moving.includes(s));
  const at = after ? rest.indexOf(after) + 1 : 0;
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  order.forEach((s, i) => {
    if (draft.sheets[i] !== s) draft.markMeta(s);
  });
  draft.sheets = order;
}

function shiftSparse(map: Record<number, number>, fn: (i: number) => number | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(map)) {
    const n = fn(Number(k));
    if (n !== null) out[n] = v;
  }
  return out;
}

function moveCells(sheet: MutableSheet, axis: Axis, fn: (i: number) => number | null): Map<number, Cell> {
  const out = new Map<number, Cell>();
  for (const [key, cell] of sheet.cells) {
    const r = keyRow(key);
    const c = keyCol(key);
    const n = fn(axis === "row" ? r : c);
    if (n === null) continue;
    out.set(axis === "row" ? cellKey(n, c) : cellKey(r, n), cell);
  }
  return out;
}

function insert(draft: Draft, sheet: MutableSheet, axis: Axis, at: number, count: number): void {
  draft.rewriteFormulas((ref, owner) =>
    draft.targetOf(ref, owner) === sheet.id ? shiftForInsert(ref, axis, at, count) : null,
  );
  const shift = (i: number) => (i >= at ? i + count : i);
  draft.replaceCells(sheet, moveCells(sheet, axis, shift));
  if (axis === "row") {
    sheet.rowCount += count;
    sheet.rowHeights = shiftSparse(sheet.rowHeights, shift);
    if (at < sheet.settings.lastFrozenRow) {
      sheet.settings = { ...sheet.settings, lastFrozenRow: sheet.settings.lastFrozenRow + count };
    }
  } else {
    sheet.columnCount += count;
    sheet.columnWidths = shiftSparse(sheet.columnWidths, shift);
    if (at < sheet.settings.lastFrozenColumn) {
      sheet.settings = { ...sheet.settings, lastFrozenColumn: sheet.settings.lastFrozenColumn + count };
    }
  }
  draft.markMeta(sheet);
}

function remove(draft: Draft, sheet: MutableSheet, axis: Axis, indices: ReadonlyArray<number>): void {
  const total = axis === "row" ? sheet.rowCount : sheet.columnCount;
  if (indices.length >= total) throw new Refuse("badRange", `A sheet keeps at least one ${axis === "row" ? "row" : "column"}`);
  for (const [from, count] of blocksDescending(indices)) {
    draft.rewriteFormulas((ref, owner) =>
      draft.targetOf(ref, owner) === sheet.id ? shiftForDelete(ref, axis, from, count) : null,
    );
    const shift = (i: number) => (i < from ? i : i < from + count ? null : i - count);
    const cells = moveCells(sheet, axis, shift);
    draft.cellCount -= sheet.cells.size - cells.size;
    draft.replaceCells(sheet, cells);
    const frozenKey = axis === "row" ? "lastFrozenRow" : "lastFrozenColumn";
    const frozen = sheet.settings[frozenKey];
    const overlap = Math.max(0, Math.min(frozen, from + count) - from);
    if (overlap > 0) sheet.settings = { ...sheet.settings, [frozenKey]: frozen - overlap };
    if (axis === "row") {
      sheet.rowCount -= count;
      sheet.rowHeights = shiftSparse(sheet.rowHeights, shift);
    } else {
      sheet.columnCount -= count;
      sheet.columnWidths = shiftSparse(sheet.columnWidths, shift);
    }
  }
  draft.markMeta(sheet);
}

function sideOf(side: unknown): "before" | "after" {
  if (side !== "before" && side !== "after") throw new Refuse("badEdit", 'side must be "before" or "after"');
  return side;
}

function setSizes(
  draft: Draft,
  sheet: MutableSheet,
  key: "columnWidths" | "rowHeights",
  indices: ReadonlyArray<number>,
  px: unknown,
  field: string,
): void {
  const value = requireInt(px, 1, 2000, field);
  const fallback = key === "columnWidths" ? DEFAULT_COLUMN_WIDTH : DEFAULT_ROW_HEIGHT;
  const map = sheet[key];
  let changed = false;
  for (const i of indices) {
    const current = map[i] ?? fallback;
    if (current === value) continue;
    if (value === fallback) delete map[i];
    else map[i] = value;
    changed = true;
  }
  if (changed) draft.markMeta(sheet);
}

function setSheetSettings(draft: Draft, e: Extract<Edit, { kind: "setSheetSettings" }>): void {
  const sheet = draft.sheet(e.sheet);
  const s = e.settings as Record<string, unknown> | null;
  if (typeof s !== "object" || s === null) throw new Refuse("badEdit", "settings must be an object");
  const next = { ...sheet.settings };
  for (const [k, v] of Object.entries(s)) {
    if (k === "lastFrozenRow") next.lastFrozenRow = requireInt(v, 0, sheet.rowCount, "settings.lastFrozenRow", "badRange");
    else if (k === "lastFrozenColumn") {
      next.lastFrozenColumn = requireInt(v, 0, sheet.columnCount, "settings.lastFrozenColumn", "badRange");
    } else if (k === "areGridlinesHidden") {
      if (typeof v !== "boolean") throw new Refuse("badEdit", "settings.areGridlinesHidden must be true or false");
      next.areGridlinesHidden = v;
    } else throw new Refuse("badEdit", `settings.${k} is not a sheet setting`);
  }
  if (
    next.lastFrozenRow !== sheet.settings.lastFrozenRow ||
    next.lastFrozenColumn !== sheet.settings.lastFrozenColumn ||
    next.areGridlinesHidden !== sheet.settings.areGridlinesHidden
  ) {
    sheet.settings = next;
    draft.markMeta(sheet);
  }
}

function sortRank(v: Scalar): number {
  if (v === null || v === "") return 4;
  if (isError(v)) return 3;
  return typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
}

function sortRows(draft: Draft, e: Extract<Edit, { kind: "sortRows" }>): void {
  const sheet = draft.sheet(e.sheet);
  const rows = rowIndices(e.rows, sheet.rowCount);
  const col = typeof e.byColumn === "string" ? lettersToColumn(e.byColumn.trim()) : -1;
  if (col < 0 || col >= sheet.columnCount) throw new Refuse("badRange", `Bad byColumn ${JSON.stringify(e.byColumn)}`);
  if (e.direction !== "ascending" && e.direction !== "descending") {
    throw new Refuse("badEdit", 'direction must be "ascending" or "descending"');
  }
  draft.settle();
  const values = draft.calc.values.get(sheet.id);
  const keyOf = (r: number): Scalar => values?.get(cellKey(r, col))?.value ?? null;
  const dir = e.direction === "ascending" ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    const va = keyOf(a);
    const vb = keyOf(b);
    const ra = sortRank(va);
    const rb = sortRank(vb);
    if (ra === 4 || rb === 4) return ra - rb; // blanks last either way
    if (ra !== rb) return (ra - rb) * dir;
    if (ra === 3) return 0;
    return compareScalars(va as never, vb as never) * dir;
  });
  if (sorted.every((r, i) => r === rows[i])) return;
  const target = new Map<number, number>(); // source row -> destination row
  sorted.forEach((source, i) => target.set(source, rows[i] as number));
  const cells = new Map<number, Cell>();
  for (const [key, cell] of sheet.cells) {
    const r = keyRow(key);
    const dest = target.get(r);
    if (dest === undefined || dest === r) {
      cells.set(key, cell);
      continue;
    }
    let input = cell.input;
    if (input.startsWith("=") && input.length > 1) {
      input = rewriteFormula(input, (ref) => offsetRelative(ref, "row", dest - r)) ?? input;
    }
    cells.set(cellKey(dest, keyCol(key)), input === cell.input ? cell : { ...cell, input });
  }
  draft.replaceCells(sheet, cells);
}

function applyOne(draft: Draft, edit: Edit, editIndex: number): void {
  if (typeof edit !== "object" || edit === null) throw new Refuse("badEdit", "An edit must be an object");
  switch (edit.kind) {
    case "writeCells":
      return writeCells(draft, edit);
    case "formatCells":
      return formatCells(draft, edit);
    case "addSheet":
      return addSheet(draft, edit, editIndex);
    case "renameSheet":
      return renameSheet(draft, edit);
    case "moveSheets":
      return moveSheets(draft, edit);
    case "deleteSheet":
      return deleteSheet(draft, edit);
    case "insertRows": {
      const sheet = draft.sheet(edit.sheet);
      const beside = requireInt(edit.besideRow, 1, sheet.rowCount, "besideRow", "badRange");
      const count = requireInt(edit.count, 1, MAX_ROWS - sheet.rowCount, "count");
      return insert(draft, sheet, "row", sideOf(edit.side) === "before" ? beside - 1 : beside, count);
    }
    case "insertColumns": {
      const sheet = draft.sheet(edit.sheet);
      const col = typeof edit.besideColumn === "string" ? lettersToColumn(edit.besideColumn.trim()) : -1;
      if (col < 0 || col >= sheet.columnCount) {
        throw new Refuse("badRange", `Bad besideColumn ${JSON.stringify(edit.besideColumn)}`);
      }
      const count = requireInt(edit.count, 1, MAX_COLUMNS - sheet.columnCount, "count");
      return insert(draft, sheet, "col", sideOf(edit.side) === "before" ? col : col + 1, count);
    }
    case "deleteRows": {
      const sheet = draft.sheet(edit.sheet);
      return remove(draft, sheet, "row", rowIndices(edit.rows, sheet.rowCount));
    }
    case "deleteColumns": {
      const sheet = draft.sheet(edit.sheet);
      return remove(draft, sheet, "col", columnIndices(edit.columns, sheet.columnCount));
    }
    case "setColumnWidths": {
      const sheet = draft.sheet(edit.sheet);
      const cols = columnIndices(edit.columns, sheet.columnCount);
      return setSizes(draft, sheet, "columnWidths", cols, edit.widthInPixels, "widthInPixels");
    }
    case "setRowHeights": {
      const sheet = draft.sheet(edit.sheet);
      const rows = rowIndices(edit.rows, sheet.rowCount);
      return setSizes(draft, sheet, "rowHeights", rows, edit.heightInPixels, "heightInPixels");
    }
    case "setSheetSettings":
      return setSheetSettings(draft, edit);
    case "sortRows":
      return sortRows(draft, edit);
    default:
      throw new Refuse("badEdit", `Unknown edit kind ${JSON.stringify((edit as { kind?: unknown }).kind)}`);
  }
}

function writtenCells(edit: unknown): number {
  const e = edit as { kind?: unknown; rows?: unknown };
  if (e?.kind !== "writeCells" || !Array.isArray(e.rows)) return 0;
  return e.rows.reduce((n: number, row: unknown) => n + (Array.isArray(row) ? row.length : 0), 0);
}

/**
 * Applies an edit list against `base`. All edits land or none does. Returns
 * the new workbook (revision + 1) and what changed, or a refusal.
 */
export function applyEdits(workbook: Workbook, base: number, edits: ReadonlyArray<Edit>): Applied | Refusal {
  if (base !== workbook.revision) {
    return {
      refusal: "baseIsNotTheRevision",
      editIndex: null,
      detail: `base is ${base}; the revision is ${workbook.revision}`,
    };
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    return { refusal: "nothingToChange", editIndex: null, detail: "The edit list is empty" };
  }
  let written = 0;
  for (let i = 0; i < edits.length; i++) {
    written += writtenCells(edits[i]);
    if (written > MAX_CELLS_PER_EDIT_LIST) {
      return {
        refusal: "tooManyCells",
        editIndex: i,
        detail: `An edit list writes at most ${MAX_CELLS_PER_EDIT_LIST} cells; split it (about 1,000 per list)`,
      };
    }
  }
  const draft = new Draft(workbook);
  for (let i = 0; i < edits.length; i++) {
    try {
      applyOne(draft, edits[i] as Edit, i);
      if (draft.cellCount > MAX_WORKBOOK_CELLS) {
        throw new Refuse("workbookFull", `A workbook holds at most ${MAX_WORKBOOK_CELLS} filled cells`);
      }
    } catch (e) {
      if (e instanceof Refuse) return { refusal: e.refusal, editIndex: i, detail: e.detail };
      throw e;
    }
  }
  if (!draft.anyChange) return { refusal: "nothingToChange", editIndex: null, detail: "The edits change nothing" };
  return draft.finish();
}

// ---- reads ----

/** Effective number format: the cell's own, else the one implied by its formula. */
export function effectivePattern(cell: Cell | undefined, computed: Computed | undefined): string | null {
  return cell?.format?.numberFormat?.pattern ?? computed?.pattern ?? null;
}

/** Read shape of one cell. */
export function cellRead(cell: Cell | undefined, computed: Computed | undefined): CellRead {
  if (!cell || cell.input === "") return null;
  const value: Scalar = computed?.value ?? null;
  const pattern = effectivePattern(cell, computed);
  if (cell.input.startsWith("=") && cell.input.length > 1) {
    if (typeof value === "number" && pattern) return { formula: cell.input, value, shown: display(value, pattern) };
    return { formula: cell.input, value };
  }
  if (typeof value !== "number") return value;
  if (!pattern) return value;
  switch (patternKind(pattern)) {
    case "date":
      return { date: isoDate(value) };
    case "time":
      return { time: isoTime(value) };
    case "dateTime":
      return { dateTime: isoDateTime(value) };
    default:
      return { number: value, shown: display(value, pattern) };
  }
}

export interface CellView {
  readonly input: string;
  readonly format: CellFormat | undefined;
  readonly value: Scalar;
  /** Effective number format (explicit or implied). */
  readonly pattern: string | null;
  /** What the grid shows. */
  readonly shown: string;
}

/** Everything the grid needs for one cell. */
export function viewCell(workbook: Workbook, sheetId: SheetId, row: number, col: number): CellView {
  const key = cellKey(row, col);
  const cell = workbook.sheets.find((s) => s.id === sheetId)?.cells.get(key);
  const computed = workbook.calc.values.get(sheetId)?.get(key);
  const value = computed?.value ?? null;
  const pattern = effectivePattern(cell, computed);
  return { input: cell?.input ?? "", format: cell?.format, value, pattern, shown: display(value, pattern) };
}

/** Bounding box of cells with input, 0-based inclusive, or null. */
export function filledBounds(sheet: Sheet): { r1: number; c1: number; r2: number; c2: number } | null {
  let b: { r1: number; c1: number; r2: number; c2: number } | null = null;
  for (const [key, cell] of sheet.cells) {
    if (cell.input === "") continue;
    const r = keyRow(key);
    const c = keyCol(key);
    if (!b) b = { r1: r, c1: c, r2: r, c2: c };
    else {
      b.r1 = Math.min(b.r1, r);
      b.c1 = Math.min(b.c1, c);
      b.r2 = Math.max(b.r2, r);
      b.c2 = Math.max(b.c2, c);
    }
  }
  return b;
}

/**
 * Reads a range (A1, A1:D4, C:C, 2:2, F2:F) in the read shape. Open ends stop at
 * the last filled row/column; bounds past the sheet are clamped to it.
 */
export function readCells(workbook: Workbook, sheet: string, range: string): CellsRead | Refusal {
  const s = findSheet(workbook, sheet);
  if (!s) return { refusal: "unknownSheet", editIndex: null, detail: `No sheet named ${JSON.stringify(sheet)}` };
  const area = parseArea(range);
  if (!area) return { refusal: "badRange", editIndex: null, detail: `Bad range ${JSON.stringify(range)}` };
  const filled = filledBounds(s);
  const r1 = area.startRow ?? 0;
  const c1 = area.startCol ?? 0;
  const r2 = Math.min(area.endRow ?? Math.max(r1, filled?.r2 ?? 0), s.rowCount - 1);
  const c2 = Math.min(area.endCol ?? Math.max(c1, filled?.c2 ?? 0), s.columnCount - 1);
  if (r1 > r2 || c1 > c2) {
    return { refusal: "badRange", editIndex: null, detail: `${range} is outside the sheet's ${s.rowCount} rows and ${s.columnCount} columns` };
  }
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_CELLS_PER_READ) {
    return { refusal: "tooManyCells", editIndex: null, detail: `Read at most ${MAX_CELLS_PER_READ} cells at a time` };
  }
  const values = workbook.calc.values.get(s.id);
  const rows: CellRead[][] = [];
  for (let r = r1; r <= r2; r++) {
    const row: CellRead[] = [];
    for (let c = c1; c <= c2; c++) {
      const key = cellKey(r, c);
      row.push(cellRead(s.cells.get(key), values?.get(key)));
    }
    rows.push(row);
  }
  return {
    sheet: s.name,
    sheetId: s.id,
    range: formatArea({ startRow: r1, startCol: c1, endRow: r2, endCol: c2 }),
    rows,
  };
}

/** Every sheet in order with its size, settings and filled range. */
export function readSheets(workbook: Workbook): SheetsRead {
  return {
    revision: workbook.revision,
    sheets: workbook.sheets.map((s, index) => {
      const b = filledBounds(s);
      return {
        id: s.id,
        name: s.name,
        index,
        rowCount: s.rowCount,
        columnCount: s.columnCount,
        settings: s.settings,
        filledRange: b ? formatArea({ startRow: b.r1, startCol: b.c1, endRow: b.r2, endCol: b.c2 }) : null,
      };
    }),
  };
}
