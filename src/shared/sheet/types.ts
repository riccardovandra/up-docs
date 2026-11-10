// Sheets model: a workbook of tabs (sheets), each a grid of cells addressed A1.
// Mirrors the Claude Sheets agent API: ordered edit lists applied against a
// `base` revision, cell input "as if typed", and the read shape of a cell.
// Rows and columns are 0-based in the model and in storage records; edits and
// reads use A1 text (1-based rows, column letters) as an agent would type.

import type { CompiledFormula } from "./recalc.ts";

export type SheetId = string;

export interface SheetSettings {
  /** 1-based index of the last frozen row; 0 = none. */
  readonly lastFrozenRow: number;
  /** 1-based index of the last frozen column; 0 = none. */
  readonly lastFrozenColumn: number;
  readonly areGridlinesHidden: boolean;
}

export type HorizontalAlignment = "left" | "center" | "right";

export interface CellFormat {
  readonly numberFormat?: { readonly pattern: string };
  readonly alignment?: { readonly horizontal?: HorizontalAlignment; readonly wrap?: boolean };
  /** `#rrggbb`. */
  readonly fillColor?: string;
  readonly font?: {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
    /** `#rrggbb`. */
    readonly color?: string;
    readonly size?: number;
  };
}

/** A stored cell. `input` is the text as typed ("" = format only). */
export interface Cell {
  readonly input: string;
  readonly format?: CellFormat;
}

export interface Sheet {
  /** Stable id, separate from the name; never reused within a workbook. */
  readonly id: SheetId;
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly settings: SheetSettings;
  /** Sparse: 0-based column index -> pixels. Missing = DEFAULT_COLUMN_WIDTH. */
  readonly columnWidths: Readonly<Record<number, number>>;
  /** Sparse: 0-based row index -> pixels. Missing = DEFAULT_ROW_HEIGHT. */
  readonly rowHeights: Readonly<Record<number, number>>;
  /** Keyed by `cellKey(row, col)`. */
  readonly cells: ReadonlyMap<number, Cell>;
}

export type ErrorCode =
  | "#REF!"
  | "#DIV/0!"
  | "#NAME?"
  | "#VALUE!"
  | "#N/A"
  | "#NUM!"
  | "#CYCLE!"
  /** Formula text that does not parse. */
  | "#ERROR!";

export interface ErrorValue {
  readonly error: ErrorCode;
}

/** A computed cell value. `null` is blank. */
export type Scalar = number | string | boolean | null | ErrorValue;

/** Computed state of one cell. `pattern` is the implied number format (from typed input or formula). */
export interface Computed {
  readonly value: Scalar;
  readonly pattern: string | null;
}

export interface EngineOptions {
  /** Clock for TODAY and NOW, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Offset from UTC used by TODAY and NOW, minutes. Default 0. */
  readonly utcOffsetMinutes?: number;
}

/** Derived formula state and computed values. Built by the engine; never serialized. */
export interface Calc {
  readonly options: Required<EngineOptions>;
  readonly values: ReadonlyMap<SheetId, ReadonlyMap<number, Computed>>;
  readonly formulas: ReadonlyMap<SheetId, ReadonlyMap<number, CompiledFormula>>;
}

export interface Workbook {
  readonly revision: number;
  readonly sheets: ReadonlyArray<Sheet>;
  readonly calc: Calc;
}

// ---- Edits (kind names and keys match Claude Sheets) ----

/** As typed: string input, number, boolean, or null to clear. */
export type CellInput = string | number | boolean | null;

/** Rows are 1-based numbers or "a:b" spans; columns are letters or "A:C" spans. */
export type RowSpec = number | string;
export type ColumnSpec = string;

/** A format change: given keys are set, `null` removes the key. */
export interface FormatPatch {
  readonly numberFormat?: { readonly pattern: string } | null;
  readonly alignment?: {
    readonly horizontal?: HorizontalAlignment | null;
    readonly wrap?: boolean | null;
  } | null;
  readonly fillColor?: string | null;
  readonly font?: {
    readonly bold?: boolean | null;
    readonly italic?: boolean | null;
    readonly underline?: boolean | null;
    readonly strikethrough?: boolean | null;
    readonly color?: string | null;
    readonly size?: number | null;
  } | null;
}

export type Side = "before" | "after";

export type Edit =
  | {
      readonly kind: "writeCells";
      readonly sheet: string;
      readonly topLeft: string;
      readonly rows: ReadonlyArray<ReadonlyArray<CellInput>>;
    }
  | {
      readonly kind: "formatCells";
      readonly sheet: string;
      readonly ranges: ReadonlyArray<string>;
      readonly format: FormatPatch;
    }
  | { readonly kind: "addSheet"; readonly name: string }
  | { readonly kind: "renameSheet"; readonly sheet: string; readonly name: string }
  | {
      readonly kind: "moveSheets";
      readonly sheets: ReadonlyArray<string>;
      /** null moves them to the front. */
      readonly afterSheet: string | null;
    }
  | { readonly kind: "deleteSheet"; readonly sheet: string }
  | {
      readonly kind: "insertRows";
      readonly sheet: string;
      /** 1-based. */
      readonly besideRow: number;
      readonly side: Side;
      readonly count: number;
    }
  | {
      readonly kind: "insertColumns";
      readonly sheet: string;
      /** Column letter. */
      readonly besideColumn: string;
      readonly side: Side;
      readonly count: number;
    }
  | { readonly kind: "deleteRows"; readonly sheet: string; readonly rows: ReadonlyArray<RowSpec> }
  | {
      readonly kind: "deleteColumns";
      readonly sheet: string;
      readonly columns: ReadonlyArray<ColumnSpec>;
    }
  | {
      readonly kind: "setColumnWidths";
      readonly sheet: string;
      readonly columns: ReadonlyArray<ColumnSpec>;
      readonly widthInPixels: number;
    }
  | {
      readonly kind: "setRowHeights";
      readonly sheet: string;
      readonly rows: ReadonlyArray<RowSpec>;
      readonly heightInPixels: number;
    }
  | {
      readonly kind: "setSheetSettings";
      readonly sheet: string;
      readonly settings: Partial<SheetSettings>;
    }
  | {
      readonly kind: "sortRows";
      readonly sheet: string;
      readonly rows: ReadonlyArray<RowSpec>;
      /** Column letter. */
      readonly byColumn: string;
      readonly direction: "ascending" | "descending";
    };

export type EditKind = Edit["kind"];

// ---- Results ----

export type RefusalName =
  | "baseIsNotTheRevision"
  | "unknownSheet"
  | "badRange"
  | "badEdit"
  | "badName"
  | "sheetNameTaken"
  | "lastSheet"
  | "nothingToChange"
  | "tooManyCells"
  | "workbookFull";

export interface Refusal {
  readonly refusal: RefusalName;
  /** Index of the edit that was refused; null when the list as a whole was. */
  readonly editIndex: number | null;
  readonly detail: string;
}

export interface CellPosition {
  readonly sheetId: SheetId;
  /** 0-based. */
  readonly row: number;
  /** 0-based. */
  readonly col: number;
}

export interface Changes {
  /** Cells whose input or format changed, outside `rebuiltSheets`. Absent cell = deleted. */
  readonly cells: ReadonlyArray<CellPosition>;
  /** Sheets whose cells moved wholesale (rows/columns inserted, deleted or sorted): replace all their cells. */
  readonly rebuiltSheets: ReadonlyArray<SheetId>;
  /** Sheets added or whose name, position, size, settings, widths or heights changed. */
  readonly sheets: ReadonlyArray<SheetId>;
  readonly deletedSheets: ReadonlyArray<SheetId>;
  /** Cells whose computed value or implied format changed, outside `rebuiltSheets`. */
  readonly values: ReadonlyArray<CellPosition>;
}

export interface Applied {
  readonly workbook: Workbook;
  readonly revision: number;
  readonly changed: Changes;
}

// ---- Read shapes ----

export type CellValueRead = number | string | boolean | null | ErrorValue;

/**
 * Read shape of a cell:
 * null | number | boolean | text | {number, shown} | {date} | {time} | {dateTime} | {formula, value, shown?}.
 * `date` is yyyy-mm-dd, `time` HH:MM:SS, `dateTime` yyyy-mm-ddTHH:MM:SS.
 */
export type CellRead =
  | null
  | number
  | boolean
  | string
  | ErrorValue
  | { readonly number: number; readonly shown: string }
  | { readonly date: string }
  | { readonly time: string }
  | { readonly dateTime: string }
  | { readonly formula: string; readonly value: CellValueRead; readonly shown?: string };

export interface CellsRead {
  readonly sheet: string;
  readonly sheetId: SheetId;
  /** The range actually read, after clamping, e.g. "A1:D4". */
  readonly range: string;
  readonly rows: ReadonlyArray<ReadonlyArray<CellRead>>;
}

export interface SheetSummary {
  readonly id: SheetId;
  readonly name: string;
  readonly index: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly settings: SheetSettings;
  /** Bounding box of cells with input, e.g. "A1:D12"; null when empty. */
  readonly filledRange: string | null;
}

export interface SheetsRead {
  readonly revision: number;
  readonly sheets: ReadonlyArray<SheetSummary>;
}

// ---- Defaults and limits ----

export const DEFAULT_ROW_COUNT = 1000;
export const DEFAULT_COLUMN_COUNT = 26;
export const DEFAULT_COLUMN_WIDTH = 104;
export const DEFAULT_ROW_HEIGHT = 28;
/** Stored cells (with input or format) per workbook. */
export const MAX_WORKBOOK_CELLS = 200_000;
/** Soft guide for cells written per edit list. */
export const SUGGESTED_CELLS_PER_EDIT_LIST = 1_000;
/** Hard limit for cells written by writeCells per edit list. */
export const MAX_CELLS_PER_EDIT_LIST = 2_000;
/** Cells returned per readCells call. */
export const MAX_CELLS_PER_READ = 10_000;
export const MAX_ROWS = 1_000_000;
/** Column ZZZ. */
export const MAX_COLUMNS = 18_278;
export const MAX_SHEET_NAME_LENGTH = 100;

/** Map key of a cell; MAX_COLUMNS < 32768. */
export function cellKey(row: number, col: number): number {
  return row * 32768 + col;
}

export function keyRow(key: number): number {
  return Math.floor(key / 32768);
}

export function keyCol(key: number): number {
  return key % 32768;
}
