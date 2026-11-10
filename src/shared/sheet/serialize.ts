// Storage seam: a workbook maps to one record per sheet (tab) and one record
// per stored cell (row, col, input, format), matching the planned D1 tables
// `sheet_tabs` and `sheet_cells`. Rows and columns are 0-based. Computed values
// are never stored: `workbookFromRecords` recomputes them.

import { emptySheet, workbookFromSheets } from "./workbook.ts";
import {
  cellKey,
  keyCol,
  keyRow,
  type Cell,
  type CellFormat,
  type Changes,
  type EngineOptions,
  type Sheet,
  type SheetId,
  type SheetSettings,
  type Workbook,
} from "./types.ts";

export interface SheetRecord {
  readonly id: SheetId;
  readonly name: string;
  /** 0-based tab order. */
  readonly position: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly settings: SheetSettings;
  /** Sparse, JSON object keys are 0-based column indices. */
  readonly columnWidths: Readonly<Record<number, number>>;
  /** Sparse, JSON object keys are 0-based row indices. */
  readonly rowHeights: Readonly<Record<number, number>>;
}

export interface CellRecord {
  readonly sheetId: SheetId;
  readonly row: number;
  readonly col: number;
  /** As typed; "" for a format-only cell. */
  readonly input: string;
  readonly format: CellFormat | null;
}

export interface WorkbookRecords {
  readonly revision: number;
  readonly sheets: ReadonlyArray<SheetRecord>;
  readonly cells: ReadonlyArray<CellRecord>;
}

export function sheetToRecord(sheet: Sheet, position: number): SheetRecord {
  return {
    id: sheet.id,
    name: sheet.name,
    position,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    settings: sheet.settings,
    columnWidths: sheet.columnWidths,
    rowHeights: sheet.rowHeights,
  };
}

export function cellToRecord(sheetId: SheetId, row: number, col: number, cell: Cell): CellRecord {
  return { sheetId, row, col, input: cell.input, format: cell.format ?? null };
}

/** All stored cells of a sheet. */
export function sheetCellRecords(sheet: Sheet): CellRecord[] {
  const out: CellRecord[] = [];
  for (const [key, cell] of sheet.cells) out.push(cellToRecord(sheet.id, keyRow(key), keyCol(key), cell));
  return out;
}

export function workbookToRecords(workbook: Workbook): WorkbookRecords {
  return {
    revision: workbook.revision,
    sheets: workbook.sheets.map(sheetToRecord),
    cells: workbook.sheets.flatMap(sheetCellRecords),
  };
}

/** Rebuilds a workbook (and computes every formula) from stored records. */
export function workbookFromRecords(records: WorkbookRecords, options: EngineOptions = {}): Workbook {
  const bySheet = new Map<SheetId, Map<number, Cell>>();
  for (const r of records.cells) {
    let cells = bySheet.get(r.sheetId);
    if (!cells) bySheet.set(r.sheetId, (cells = new Map()));
    cells.set(cellKey(r.row, r.col), r.format ? { input: r.input, format: r.format } : { input: r.input });
  }
  const sheets: Sheet[] = [...records.sheets]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      ...emptySheet(s.id, s.name),
      rowCount: s.rowCount,
      columnCount: s.columnCount,
      settings: s.settings,
      columnWidths: s.columnWidths,
      rowHeights: s.rowHeights,
      cells: bySheet.get(s.id) ?? new Map(),
    }));
  return workbookFromSheets(records.revision, sheets, options);
}

/** What a store writes after an edit list: upserts and deletes, derived from `changed`. */
export interface RecordChanges {
  readonly revision: number;
  /** Sheets to insert or update (all sheets whose record changed, including position). */
  readonly upsertSheets: ReadonlyArray<SheetRecord>;
  readonly deleteSheets: ReadonlyArray<SheetId>;
  /** Sheets whose cells must all be deleted before `upsertCells` (cells moved). */
  readonly replaceCellsOf: ReadonlyArray<SheetId>;
  readonly upsertCells: ReadonlyArray<CellRecord>;
  readonly deleteCells: ReadonlyArray<{ readonly sheetId: SheetId; readonly row: number; readonly col: number }>;
}

/** Turns an applied edit list's `changed` into record writes against the new workbook. */
export function recordChanges(workbook: Workbook, changed: Changes): RecordChanges {
  const byId = new Map(workbook.sheets.map((s, i) => [s.id, { sheet: s, position: i }]));
  const upsertSheets: SheetRecord[] = [];
  for (const id of changed.sheets) {
    const hit = byId.get(id);
    if (hit) upsertSheets.push(sheetToRecord(hit.sheet, hit.position));
  }
  const upsertCells: CellRecord[] = [];
  const deleteCells: Array<{ sheetId: SheetId; row: number; col: number }> = [];
  for (const id of changed.rebuiltSheets) {
    const hit = byId.get(id);
    if (hit) upsertCells.push(...sheetCellRecords(hit.sheet));
  }
  for (const p of changed.cells) {
    const cell = byId.get(p.sheetId)?.sheet.cells.get(cellKey(p.row, p.col));
    if (cell) upsertCells.push(cellToRecord(p.sheetId, p.row, p.col, cell));
    else deleteCells.push({ sheetId: p.sheetId, row: p.row, col: p.col });
  }
  return {
    revision: workbook.revision,
    upsertSheets,
    deleteSheets: changed.deletedSheets,
    replaceCellsOf: changed.rebuiltSheets,
    upsertCells,
    deleteCells,
  };
}
