// Test helpers: build workbooks from edit lists and read values by A1.

import { parseCellAddress } from "./address.ts";
import { applyEdits, createWorkbook, findSheet, isRefusal, viewCell } from "./workbook.ts";
import type { Applied, CellInput, Edit, EngineOptions, Scalar, Workbook } from "./types.ts";

/** Fixed clock: 2026-03-15 12:00 UTC. */
export const FIXED_NOW = Date.UTC(2026, 2, 15, 12, 0, 0);

export function fresh(options: EngineOptions = {}): Workbook {
  return createWorkbook({ now: () => FIXED_NOW, ...options });
}

/** Applies edits and throws on refusal. */
export function apply(workbook: Workbook, edits: ReadonlyArray<Edit>): Applied {
  const r = applyEdits(workbook, workbook.revision, edits);
  if (isRefusal(r)) throw new Error(`${r.refusal} at ${r.editIndex}: ${r.detail}`);
  return r;
}

/** Writes rows at topLeft on a sheet and returns the new workbook. */
export function write(
  workbook: Workbook,
  sheet: string,
  topLeft: string,
  rows: ReadonlyArray<ReadonlyArray<CellInput>>,
): Workbook {
  return apply(workbook, [{ kind: "writeCells", sheet, topLeft, rows }]).workbook;
}

/** Computed value of a cell by A1 on a sheet name. */
export function valueAt(workbook: Workbook, sheet: string, a1: string): Scalar {
  const s = findSheet(workbook, sheet);
  const at = parseCellAddress(a1);
  if (!s || !at) throw new Error(`bad ${sheet}!${a1}`);
  return viewCell(workbook, s.id, at.row, at.col).value;
}

export function shownAt(workbook: Workbook, sheet: string, a1: string): string {
  const s = findSheet(workbook, sheet);
  const at = parseCellAddress(a1);
  if (!s || !at) throw new Error(`bad ${sheet}!${a1}`);
  return viewCell(workbook, s.id, at.row, at.col).shown;
}

export function inputAt(workbook: Workbook, sheet: string, a1: string): string {
  const s = findSheet(workbook, sheet);
  const at = parseCellAddress(a1);
  if (!s || !at) throw new Error(`bad ${sheet}!${a1}`);
  return viewCell(workbook, s.id, at.row, at.col).input;
}

/** Evaluates one formula in a scratch cell (Z1000 of the first sheet). */
export function calc(workbook: Workbook, formula: string): Scalar {
  const sheet = workbook.sheets[0]?.name ?? "Sheet1";
  return valueAt(write(workbook, sheet, "Z1000", [[formula]]), sheet, "Z1000");
}
