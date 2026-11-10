// Undo and redo of this page's own cell writes and format changes. Each is
// undone by sending its inverse: the inputs and formats the touched cells had
// before, written back as ordinary edits, so other people see the undo land.

import { formatArea, parseArea, parseCellAddress } from "../../shared/sheet/address.ts";
import { applyEdits, findSheet, isRefusal } from "../../shared/sheet/workbook.ts";
import {
  cellKey,
  type Cell,
  type CellFormat,
  type CellInput,
  type Edit,
  type FormatPatch,
  type Workbook,
} from "../../shared/sheet/types.ts";
import type { Rect } from "./selection.ts";

/** The rectangles an edit writes or formats, on which tab; null for other kinds. */
function touched(workbook: Workbook, edit: Edit): { sheetId: string; rects: Rect[] } | null {
  if (edit.kind !== "writeCells" && edit.kind !== "formatCells") return null;
  const sheet = findSheet(workbook, edit.sheet);
  if (!sheet) return null;
  if (edit.kind === "writeCells") {
    const at = parseCellAddress(edit.topLeft);
    if (!at) return null;
    const width = Math.max(0, ...edit.rows.map((row) => row.length));
    if (width === 0 || edit.rows.length === 0) return { sheetId: sheet.id, rects: [] };
    return {
      sheetId: sheet.id,
      rects: [{ r1: at.row, c1: at.col, r2: at.row + edit.rows.length - 1, c2: at.col + width - 1 }],
    };
  }
  const rects: Rect[] = [];
  for (const range of edit.ranges) {
    const area = parseArea(range);
    if (!area) continue;
    rects.push({
      r1: area.startRow ?? 0,
      c1: area.startCol ?? 0,
      r2: area.endRow ?? sheet.rowCount - 1,
      c2: area.endCol ?? sheet.columnCount - 1,
    });
  }
  return { sheetId: sheet.id, rects };
}

const sameFormat = (a: CellFormat | undefined, b: CellFormat | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A patch that turns any format into exactly `format`. */
export function exactFormat(format: CellFormat | undefined): FormatPatch {
  const alignment = format?.alignment;
  const font = format?.font;
  return {
    numberFormat: format?.numberFormat ?? null,
    alignment: alignment
      ? { horizontal: alignment.horizontal ?? null, wrap: alignment.wrap ?? null }
      : null,
    fillColor: format?.fillColor ?? null,
    font: font
      ? {
          bold: font.bold ?? null,
          italic: font.italic ?? null,
          underline: font.underline ?? null,
          strikethrough: font.strikethrough ?? null,
          color: font.color ?? null,
          size: font.size ?? null,
        }
      : null,
  };
}

/**
 * The edits that put back what `edits` change, computed against `workbook`
 * as it is before them. Null when the edits do not apply, or touch more than
 * cells (tabs, rows, sizes): those are not undone.
 */
export function inverseOf(workbook: Workbook, edits: ReadonlyArray<Edit>): Edit[] | null {
  const after = applyEdits(workbook, workbook.revision, edits);
  if (isRefusal(after)) return null;
  const writes: Edit[] = [];
  const formats = new Map<string, { sheetId: string; format: CellFormat | undefined; ranges: string[] }>();
  for (const edit of edits) {
    const target = touched(workbook, edit);
    if (!target) return null;
    const before = workbook.sheets.find((sheet) => sheet.id === target.sheetId);
    const now = after.workbook.sheets.find((sheet) => sheet.id === target.sheetId);
    if (!before || !now) return null;
    for (const rect of target.rects) {
      if (edit.kind === "writeCells") {
        const rows: CellInput[][] = [];
        let differs = false;
        for (let row = rect.r1; row <= rect.r2; row++) {
          const line: CellInput[] = [];
          for (let col = rect.c1; col <= rect.c2; col++) {
            const was = before.cells.get(cellKey(row, col))?.input ?? "";
            const is = now.cells.get(cellKey(row, col))?.input ?? "";
            if (was !== is) differs = true;
            line.push(was === "" ? null : was);
          }
          rows.push(line);
        }
        if (differs) {
          writes.push({
            kind: "writeCells",
            sheet: target.sheetId,
            topLeft: formatArea({ startRow: rect.r1, startCol: rect.c1, endRow: rect.r1, endCol: rect.c1 }),
            rows,
          });
        }
      }
      for (let row = rect.r1; row <= rect.r2; row++) {
        // Runs of cells along the row that go back to the same format share a range.
        let runStart = -1;
        let runFormat: CellFormat | undefined;
        const flush = (endCol: number) => {
          if (runStart < 0) return;
          const key = `${target.sheetId}\u0000${JSON.stringify(runFormat ?? null)}`;
          const group = formats.get(key) ?? { sheetId: target.sheetId, format: runFormat, ranges: [] };
          group.ranges.push(formatArea({ startRow: row, startCol: runStart, endRow: row, endCol }));
          formats.set(key, group);
          runStart = -1;
        };
        for (let col = rect.c1; col <= rect.c2; col++) {
          const was: Cell | undefined = before.cells.get(cellKey(row, col));
          const is: Cell | undefined = now.cells.get(cellKey(row, col));
          if (sameFormat(was?.format, is?.format)) {
            flush(col - 1);
            continue;
          }
          if (runStart >= 0 && !sameFormat(runFormat, was?.format)) flush(col - 1);
          if (runStart < 0) {
            runStart = col;
            runFormat = was?.format;
          }
        }
        flush(rect.c2);
      }
    }
  }
  const restores: Edit[] = [...formats.values()].map((group) => ({
    kind: "formatCells",
    sheet: group.sheetId,
    ranges: group.ranges,
    format: exactFormat(group.format),
  }));
  // Inputs first: typing "10%" back sets a format, which the restore then puts exactly.
  return [...writes, ...restores];
}

/** Cells per list this page sends; the engine allows 2,000 written cells per list. */
export const CELLS_PER_LIST = 1000;
const EDITS_PER_LIST = 200;
const RANGES_PER_EDIT = 400;

const cellsOf = (edit: Edit) =>
  edit.kind === "writeCells" ? edit.rows.reduce((sum, row) => sum + row.length, 0) : 0;

/** Splits big writes and long range lists so each list stays inside the server's limits. */
export function chunkEdits(edits: ReadonlyArray<Edit>): Edit[][] {
  const pieces: Edit[] = [];
  for (const edit of edits) {
    if (edit.kind === "writeCells" && cellsOf(edit) > CELLS_PER_LIST) {
      const at = parseCellAddress(edit.topLeft);
      const width = Math.max(1, ...edit.rows.map((row) => row.length));
      const rowsPer = Math.max(1, Math.floor(CELLS_PER_LIST / width));
      if (!at) {
        pieces.push(edit);
        continue;
      }
      for (let start = 0; start < edit.rows.length; start += rowsPer) {
        pieces.push({
          ...edit,
          topLeft: formatArea({
            startRow: at.row + start,
            startCol: at.col,
            endRow: at.row + start,
            endCol: at.col,
          }),
          rows: edit.rows.slice(start, start + rowsPer),
        });
      }
    } else if (edit.kind === "formatCells" && edit.ranges.length > RANGES_PER_EDIT) {
      for (let start = 0; start < edit.ranges.length; start += RANGES_PER_EDIT) {
        pieces.push({ ...edit, ranges: edit.ranges.slice(start, start + RANGES_PER_EDIT) });
      }
    } else {
      pieces.push(edit);
    }
  }
  const lists: Edit[][] = [];
  let list: Edit[] = [];
  let cells = 0;
  for (const piece of pieces) {
    const size = cellsOf(piece);
    if (list.length > 0 && (cells + size > CELLS_PER_LIST || list.length >= EDITS_PER_LIST)) {
      lists.push(list);
      list = [];
      cells = 0;
    }
    list.push(piece);
    cells += size;
  }
  if (list.length > 0) lists.push(list);
  return lists;
}

/**
 * The inverse of edits sent as `chunkEdits` lists, list by list against the
 * workbook each one meets, so a paste past one list's limit is still undone.
 * Null when any list cannot be inverted.
 */
export function inverseOfLists(
  workbook: Workbook,
  lists: ReadonlyArray<ReadonlyArray<Edit>>,
): Edit[] | null {
  const inverses: Edit[][] = [];
  let current = workbook;
  for (const list of lists) {
    const inverse = inverseOf(current, list);
    if (!inverse) return null;
    inverses.push(inverse);
    const applied = applyEdits(current, current.revision, list);
    if (isRefusal(applied)) return null;
    current = applied.workbook;
  }
  // Later lists are put back first.
  return inverses.reverse().flat();
}

export interface UndoEntry {
  readonly forward: ReadonlyArray<Edit>;
  readonly inverse: ReadonlyArray<Edit>;
  /** The tab to show when it is undone or redone. */
  readonly sheetId: string;
}

const LIMIT = 100;

/** This page's undo and redo stacks. Applying goes through the caller's `apply`. */
export class UndoStack {
  private readonly done: UndoEntry[] = [];
  private readonly undone: UndoEntry[] = [];

  record(entry: UndoEntry): void {
    if (entry.inverse.length === 0) return;
    this.done.push(entry);
    if (this.done.length > LIMIT) this.done.shift();
    this.undone.length = 0;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Sends the last entry's inverse; returns the entry, or null when there is none. */
  undo(apply: (edits: ReadonlyArray<Edit>) => boolean): UndoEntry | null {
    const entry = this.done.pop();
    if (!entry) return null;
    if (!apply(entry.inverse)) return null;
    this.undone.push(entry);
    return entry;
  }

  /** Sends the last undone entry again, with its inverse taken from `workbook` as it is now. */
  redo(workbook: Workbook, apply: (edits: ReadonlyArray<Edit>) => boolean): UndoEntry | null {
    const entry = this.undone.pop();
    if (!entry) return null;
    const inverse = inverseOfLists(workbook, chunkEdits(entry.forward));
    if (!inverse || !apply(entry.forward)) return null;
    const again = { ...entry, inverse };
    this.done.push(again);
    return again;
  }
}
