import { describe, expect, it } from "vitest";

import { apply, fresh, inputAt, shownAt, valueAt, write } from "./testing.ts";
import {
  MAX_WORKBOOK_CELLS,
  cellKey,
  type CellInput,
  type Edit,
  type Workbook,
} from "./types.ts";
import { recordChanges, workbookFromRecords, workbookToRecords } from "./serialize.ts";
import {
  applyEdits,
  createWorkbook,
  findSheet,
  isRefusal,
  mergeFormat,
  readCells,
  readSheets,
  typedCell,
  viewCell,
} from "./workbook.ts";

function refusal(wb: Workbook, edits: ReadonlyArray<Edit>, base = wb.revision) {
  const r = applyEdits(wb, base, edits);
  if (!isRefusal(r)) throw new Error("expected a refusal");
  return r;
}

function read(wb: Workbook, sheet: string, range: string) {
  const r = readCells(wb, sheet, range);
  if (isRefusal(r)) throw new Error(r.detail);
  return r.rows;
}

describe("createWorkbook", () => {
  it("starts at revision 0 with one default sheet", () => {
    const wb = createWorkbook();
    expect(wb.revision).toBe(0);
    expect(readSheets(wb).sheets).toEqual([
      {
        id: "s0-0",
        name: "Sheet1",
        index: 0,
        rowCount: 1000,
        columnCount: 26,
        settings: { lastFrozenRow: 0, lastFrozenColumn: 0, areGridlinesHidden: false },
        filledRange: null,
      },
    ]);
  });
});

describe("applyEdits contract", () => {
  it("refuses a stale base and an empty list", () => {
    const wb = write(fresh(), "Sheet1", "A1", [[1]]);
    expect(refusal(wb, [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[2]] }], 0)).toMatchObject({
      refusal: "baseIsNotTheRevision",
      editIndex: null,
    });
    expect(refusal(wb, [])).toMatchObject({ refusal: "nothingToChange" });
    expect(refusal(wb, [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[1]] }])).toMatchObject({
      refusal: "nothingToChange",
    });
  });

  it("applies all edits or none", () => {
    const wb = fresh();
    const r = refusal(wb, [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[1]] },
      { kind: "addSheet", name: "Data" },
      { kind: "writeCells", sheet: "Nope", topLeft: "A1", rows: [[1]] },
    ]);
    expect(r).toMatchObject({ refusal: "unknownSheet", editIndex: 2 });
    expect(wb.revision).toBe(0);
    expect(wb.sheets).toHaveLength(1);
    expect(valueAt(wb, "Sheet1", "A1")).toBeNull();
  });

  it("bumps the revision once per list and names refusals", () => {
    const wb = fresh();
    const r = apply(wb, [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[1]] },
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A2", rows: [[2]] },
    ]);
    expect(r.revision).toBe(1);
    expect(r.workbook.revision).toBe(1);
    const cases: Array<[Edit, string]> = [
      [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1:B2", rows: [[1]] }, "badRange"],
      [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[{} as unknown as CellInput]] }, "badEdit"],
      [{ kind: "formatCells", sheet: "Sheet1", ranges: ["nope"], format: {} }, "badRange"],
      [{ kind: "formatCells", sheet: "Sheet1", ranges: ["A1"], format: { fillColor: "red" } }, "badEdit"],
      [{ kind: "addSheet", name: "  " }, "badName"],
      [{ kind: "addSheet", name: "sheet1" }, "sheetNameTaken"],
      [{ kind: "deleteSheet", sheet: "Sheet1" }, "lastSheet"],
      [{ kind: "insertRows", sheet: "Sheet1", besideRow: 0, side: "after", count: 1 }, "badRange"],
      [{ kind: "insertRows", sheet: "Sheet1", besideRow: 1, side: "below" as "after", count: 1 }, "badEdit"],
      [{ kind: "deleteRows", sheet: "Sheet1", rows: [1001] }, "badRange"],
      [{ kind: "deleteColumns", sheet: "Sheet1", columns: ["A:Z"] }, "badRange"],
      [{ kind: "setColumnWidths", sheet: "Sheet1", columns: ["A"], widthInPixels: 0 }, "badEdit"],
      [{ kind: "setSheetSettings", sheet: "Sheet1", settings: { lastFrozenRow: 2000 } }, "badRange"],
      [{ kind: "sortRows", sheet: "Sheet1", rows: ["1:3"], byColumn: "1", direction: "ascending" }, "badRange"],
      [{ kind: "explode" } as unknown as Edit, "badEdit"],
    ];
    for (const [edit, name] of cases) expect(refusal(r.workbook, [edit])).toMatchObject({ refusal: name, editIndex: 0 });
  });

  it("enforces the per-list and per-workbook cell limits", () => {
    const row = Array.from({ length: 26 }, () => 1);
    const rows = Array.from({ length: 77 }, () => row); // 2002 cells
    expect(refusal(fresh(), [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows }])).toMatchObject({
      refusal: "tooManyCells",
      editIndex: 0,
    });
    const ok = apply(fresh(), [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: rows.slice(0, 76) }]);
    expect(ok.revision).toBe(1);
    const big = refusal(fresh(), [{ kind: "formatCells", sheet: "Sheet1", ranges: ["A1:ZZ10000"], format: { font: { bold: true } } }]);
    expect(big.refusal).toBe("workbookFull");
    expect(MAX_WORKBOOK_CELLS).toBe(200_000);
  });
});

describe("writeCells", () => {
  it("types values, keeps formats and clears with null", () => {
    let wb = write(fresh(), "Sheet1", "A1", [["10%", "$5", "1,200", "3/15/2026", "TRUE", "'=A1", 2.5]]);
    expect(read(wb, "Sheet1", "A1:G1")).toEqual([
      [
        { number: 0.1, shown: "10%" },
        { number: 5, shown: "$5.00" },
        { number: 1200, shown: "1,200" },
        { date: "2026-03-15" },
        true,
        "=A1",
        2.5,
      ],
    ]);
    // A typed format sticks to the cell, like Sheets.
    wb = write(wb, "Sheet1", "A1", [[0.25]]);
    expect(shownAt(wb, "Sheet1", "A1")).toBe("25%");
    // Clearing keeps the format; the cell reads as empty.
    wb = write(wb, "Sheet1", "A1", [[null]]);
    expect(read(wb, "Sheet1", "A1")).toEqual([[null]]);
    expect(findSheet(wb, "Sheet1")?.cells.get(cellKey(0, 0))).toEqual({ input: "", format: { numberFormat: { pattern: "0%" } } });
    expect(readSheets(wb).sheets[0]?.filledRange).toBe("B1:G1");
  });

  it("grows the sheet to fit a write", () => {
    const wb = write(fresh(), "Sheet1", "AB1001", [["x"]]);
    expect(readSheets(wb).sheets[0]).toMatchObject({ rowCount: 1001, columnCount: 28 });
  });

  it("typedCell and mergeFormat are pure", () => {
    expect(typedCell(undefined, "7")).toEqual({ input: "7" });
    expect(typedCell({ input: "1", format: { fillColor: "#ff0000" } }, "5%")).toEqual({
      input: "5%",
      format: { fillColor: "#ff0000", numberFormat: { pattern: "0%" } },
    });
    expect(typedCell({ input: "1" }, null)).toBeUndefined();
    expect(mergeFormat({ font: { bold: true, italic: true } }, { font: { bold: null } })).toEqual({ font: { italic: true } });
    expect(mergeFormat({ font: { bold: true } }, { font: null, fillColor: "#000000" })).toEqual({ fillColor: "#000000" });
    expect(mergeFormat({ numberFormat: { pattern: "0" } }, { numberFormat: null })).toBeUndefined();
  });
});

describe("formatCells", () => {
  it("merges formats over ranges and changes what is shown", () => {
    let wb = write(fresh(), "Sheet1", "A1", [[1.234, 2]]);
    const r = apply(wb, [
      {
        kind: "formatCells",
        sheet: "Sheet1",
        ranges: ["A1:B1", "D4"],
        format: { numberFormat: { pattern: "0.0" }, font: { bold: true }, alignment: { horizontal: "center" } },
      },
    ]);
    wb = r.workbook;
    expect(shownAt(wb, "Sheet1", "A1")).toBe("1.2");
    expect(viewCell(wb, wb.sheets[0]!.id, 3, 3)).toMatchObject({ input: "", shown: "" });
    expect(r.changed.cells).toHaveLength(3);
    expect(read(wb, "Sheet1", "A1")).toEqual([[{ number: 1.234, shown: "1.2" }]]);
  });
});

describe("sheets", () => {
  it("adds sheets with stable ids, renames, moves and deletes", () => {
    let r = apply(fresh(), [
      { kind: "addSheet", name: "Data" },
      { kind: "addSheet", name: "My tab" },
    ]);
    const ids = r.workbook.sheets.map((s) => s.id);
    expect(ids).toEqual(["s0-0", "s1-0", "s1-1"]);
    expect(r.changed.sheets).toEqual(["s1-0", "s1-1"]);
    r = apply(r.workbook, [{ kind: "moveSheets", sheets: ["My tab", "Data"], afterSheet: null }]);
    expect(readSheets(r.workbook).sheets.map((s) => s.name)).toEqual(["My tab", "Data", "Sheet1"]);
    r = apply(r.workbook, [{ kind: "moveSheets", sheets: ["My tab"], afterSheet: "Sheet1" }]);
    expect(readSheets(r.workbook).sheets.map((s) => s.name)).toEqual(["Data", "Sheet1", "My tab"]);
    r = apply(r.workbook, [{ kind: "renameSheet", sheet: "s1-0", name: "Numbers" }]);
    expect(findSheet(r.workbook, "numbers")?.id).toBe("s1-0");
    r = apply(r.workbook, [{ kind: "deleteSheet", sheet: "Numbers" }]);
    expect(r.changed.deletedSheets).toEqual(["s1-0"]);
    expect(r.changed.sheets).toEqual(["s0-0", "s1-1"]);
  });

  it("rewrites references on rename and turns them into #REF! on delete", () => {
    let wb = apply(fresh(), [
      { kind: "addSheet", name: "Data" },
      { kind: "writeCells", sheet: "Data", topLeft: "A1", rows: [[5]] },
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [["=Data!A1*2", "=data!A1+'Data'!A1", "=SUM(Data!A:A)"]] },
    ]).workbook;
    expect(valueAt(wb, "Sheet1", "B1")).toBe(10);
    wb = apply(wb, [{ kind: "renameSheet", sheet: "Data", name: "Raw data" }]).workbook;
    expect(inputAt(wb, "Sheet1", "A1")).toBe("='Raw data'!A1*2");
    expect(inputAt(wb, "Sheet1", "B1")).toBe("='Raw data'!A1+'Raw data'!A1");
    expect(valueAt(wb, "Sheet1", "C1")).toBe(5);
    wb = apply(wb, [{ kind: "deleteSheet", sheet: "Raw data" }]).workbook;
    expect(inputAt(wb, "Sheet1", "A1")).toBe("=#REF!*2");
    expect(valueAt(wb, "Sheet1", "A1")).toEqual({ error: "#REF!" });
    expect(valueAt(wb, "Sheet1", "C1")).toEqual({ error: "#REF!" });
  });

  it("resolves a reference once a sheet with that name appears", () => {
    let wb = write(fresh(), "Sheet1", "A1", [["=Later!A1+1"]]);
    expect(valueAt(wb, "Sheet1", "A1")).toEqual({ error: "#REF!" });
    wb = apply(wb, [
      { kind: "addSheet", name: "Later" },
      { kind: "writeCells", sheet: "Later", topLeft: "A1", rows: [[41]] },
    ]).workbook;
    expect(valueAt(wb, "Sheet1", "A1")).toBe(42);
  });
});

describe("inserting and deleting rows and columns", () => {
  function grid() {
    return apply(fresh(), [
      { kind: "addSheet", name: "Other" },
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[1, 10], [2, 20], [3, 30], ["=SUM(A1:A3)", "=B2"]] },
      { kind: "writeCells", sheet: "Other", topLeft: "A1", rows: [["=Sheet1!A3", "=SUM(Sheet1!B:B)", "=A3"]] },
    ]).workbook;
  }

  it("shifts references in every formula on every sheet", () => {
    const r = apply(grid(), [{ kind: "insertRows", sheet: "Sheet1", besideRow: 2, side: "before", count: 2 }]);
    const wb = r.workbook;
    expect(inputAt(wb, "Sheet1", "A6")).toBe("=SUM(A1:A5)");
    expect(inputAt(wb, "Sheet1", "B6")).toBe("=B4");
    expect(inputAt(wb, "Other", "A1")).toBe("=Sheet1!A5");
    expect(inputAt(wb, "Other", "B1")).toBe("=SUM(Sheet1!B:B)");
    expect(inputAt(wb, "Other", "C1")).toBe("=A3");
    expect(valueAt(wb, "Sheet1", "A6")).toBe(6);
    expect(valueAt(wb, "Other", "A1")).toBe(3);
    expect(readSheets(wb).sheets[0]?.rowCount).toBe(1002);
    expect(r.changed.rebuiltSheets).toEqual(["s0-0"]);
    expect(r.changed.cells.map((c) => c.sheetId)).toEqual(["s1-0"]);
  });

  it("inserts columns after a column", () => {
    const wb = apply(grid(), [{ kind: "insertColumns", sheet: "Sheet1", besideColumn: "A", side: "after", count: 1 }]).workbook;
    expect(inputAt(wb, "Sheet1", "C4")).toBe("=C2");
    expect(inputAt(wb, "Other", "B1")).toBe("=SUM(Sheet1!C:C)");
    expect(valueAt(wb, "Other", "B1")).toBe(80);
    expect(readSheets(wb).sheets[0]?.columnCount).toBe(27);
  });

  it("turns deleted targets into #REF! and shrinks ranges", () => {
    const wb = apply(grid(), [{ kind: "deleteRows", sheet: "Sheet1", rows: [2] }]).workbook;
    expect(inputAt(wb, "Sheet1", "A3")).toBe("=SUM(A1:A2)");
    expect(inputAt(wb, "Sheet1", "B3")).toBe("=#REF!");
    expect(valueAt(wb, "Sheet1", "B3")).toEqual({ error: "#REF!" });
    expect(inputAt(wb, "Other", "A1")).toBe("=Sheet1!A2");
    expect(valueAt(wb, "Sheet1", "A3")).toBe(4);
    const cols = apply(grid(), [{ kind: "deleteColumns", sheet: "Sheet1", columns: ["B"] }]).workbook;
    expect(inputAt(cols, "Other", "B1")).toBe("=SUM(#REF!)");
    expect(valueAt(cols, "Other", "B1")).toEqual({ error: "#REF!" });
  });

  it("deletes several separate rows in one edit", () => {
    const wb = write(fresh(), "Sheet1", "A1", [[1], [2], [3], [4], [5], ["=SUM(A1:A5)"], ["=A5"]]);
    const after = apply(wb, [{ kind: "deleteRows", sheet: "Sheet1", rows: [1, "3:4"] }]).workbook;
    expect(read(after, "Sheet1", "A1:A4")).toEqual([[2], [5], [{ formula: "=SUM(A1:A2)", value: 7 }], [{ formula: "=A2", value: 5 }]]);
    expect(readSheets(after).sheets[0]?.rowCount).toBe(997);
  });

  it("moves frozen rows, widths and heights with the grid", () => {
    let wb = apply(fresh(), [
      { kind: "setSheetSettings", sheet: "Sheet1", settings: { lastFrozenRow: 2, areGridlinesHidden: true } },
      { kind: "setColumnWidths", sheet: "Sheet1", columns: ["B:C"], widthInPixels: 200 },
      { kind: "setRowHeights", sheet: "Sheet1", rows: [3], heightInPixels: 40 },
    ]).workbook;
    expect(wb.sheets[0]).toMatchObject({ columnWidths: { 1: 200, 2: 200 }, rowHeights: { 2: 40 } });
    wb = apply(wb, [
      { kind: "insertRows", sheet: "Sheet1", besideRow: 1, side: "before", count: 1 },
      { kind: "deleteColumns", sheet: "Sheet1", columns: ["A"] },
    ]).workbook;
    expect(wb.sheets[0]).toMatchObject({
      settings: { lastFrozenRow: 3, lastFrozenColumn: 0, areGridlinesHidden: true },
      columnWidths: { 0: 200, 1: 200 },
      rowHeights: { 3: 40 },
    });
    wb = apply(wb, [{ kind: "setColumnWidths", sheet: "Sheet1", columns: ["A"], widthInPixels: 104 }]).workbook;
    expect(wb.sheets[0]?.columnWidths).toEqual({ 1: 200 });
  });
});

describe("sortRows", () => {
  it("sorts by computed value, blanks last, carrying row formulas", () => {
    let wb = write(fresh(), "Sheet1", "A1", [
      ["Name", "Qty", "Double"],
      ["b", 3, "=B2*2"],
      ["a", null, "=B3*2"],
      ["c", 1, "=B4*2"],
      ["d", "=1+1", "=B5*2"],
    ]);
    wb = apply(wb, [{ kind: "sortRows", sheet: "Sheet1", rows: ["2:5"], byColumn: "B", direction: "ascending" }]).workbook;
    expect(read(wb, "Sheet1", "A2:C5")).toEqual([
      ["c", 1, { formula: "=B2*2", value: 2 }],
      ["d", { formula: "=1+1", value: 2 }, { formula: "=B3*2", value: 4 }],
      ["b", 3, { formula: "=B4*2", value: 6 }],
      ["a", null, { formula: "=B5*2", value: 0 }],
    ]);
    wb = apply(wb, [{ kind: "sortRows", sheet: "Sheet1", rows: ["2:5"], byColumn: "A", direction: "descending" }]).workbook;
    expect(read(wb, "Sheet1", "A2:A5")).toEqual([["d"], ["c"], ["b"], ["a"]]);
  });

  it("sees values written earlier in the same list", () => {
    const wb = apply(fresh(), [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[3], ["=0+2"], [1]] },
      { kind: "sortRows", sheet: "Sheet1", rows: ["1:3"], byColumn: "A", direction: "ascending" },
    ]).workbook;
    expect(read(wb, "Sheet1", "A1:A3")).toEqual([[1], [{ formula: "=0+2", value: 2 }], [3]]);
  });
});

describe("reads", () => {
  it("clamps open ranges to the filled area and refuses bad input", () => {
    const wb = write(fresh(), "Sheet1", "A1", [["a", "b"], ["c", "=1/0"]]);
    const r = readCells(wb, "Sheet1", "A:B");
    if (isRefusal(r)) throw new Error(r.detail);
    expect(r).toMatchObject({ sheet: "Sheet1", sheetId: "s0-0", range: "A1:B2" });
    expect(r.rows[1]).toEqual(["c", { formula: "=1/0", value: { error: "#DIV/0!" } }]);
    expect(readCells(wb, "Nope", "A1")).toMatchObject({ refusal: "unknownSheet" });
    expect(readCells(wb, "Sheet1", "A0")).toMatchObject({ refusal: "badRange" });
    expect(readCells(wb, "Sheet1", "AA1")).toMatchObject({ refusal: "badRange" });
    expect(readCells(wb, "Sheet1", "A1:Z1000")).toMatchObject({ refusal: "tooManyCells" });
  });

  it("reads times and date-times", () => {
    const wb = write(fresh(), "Sheet1", "A1", [["14:30", "2026-03-15 06:00", "=DATE(2026,1,2)"]]);
    expect(read(wb, "Sheet1", "A1:C1")).toEqual([
      [{ time: "14:30:00" }, { dateTime: "2026-03-15T06:00:00" }, { formula: "=DATE(2026,1,2)", value: 46024, shown: "2026-01-02" }],
    ]);
  });
});

describe("storage records", () => {
  it("round-trips sheets, cells and formats", () => {
    const wb = apply(fresh(), [
      { kind: "addSheet", name: "Data" },
      { kind: "writeCells", sheet: "Data", topLeft: "B2", rows: [["10%", "=B2*2"]] },
      { kind: "formatCells", sheet: "Sheet1", ranges: ["A1"], format: { fillColor: "#ffee00" } },
      { kind: "setSheetSettings", sheet: "Data", settings: { lastFrozenColumn: 1 } },
    ]).workbook;
    const records = workbookToRecords(wb);
    expect(records.sheets.map((s) => [s.id, s.position])).toEqual([
      ["s0-0", 0],
      ["s1-0", 1],
    ]);
    expect(records.cells).toContainEqual({ sheetId: "s1-0", row: 1, col: 1, input: "10%", format: { numberFormat: { pattern: "0%" } } });
    expect(records.cells).toContainEqual({ sheetId: "s0-0", row: 0, col: 0, input: "", format: { fillColor: "#ffee00" } });
    const back = workbookFromRecords(JSON.parse(JSON.stringify(records)));
    expect(workbookToRecords(back)).toEqual(records);
    expect(valueAt(back, "Data", "C2")).toBe(0.2);
  });

  it("turns changes into record writes", () => {
    const wb = write(fresh(), "Sheet1", "A1", [[1, 2]]);
    const r = apply(wb, [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[null, 3]] },
      { kind: "addSheet", name: "New" },
      { kind: "writeCells", sheet: "New", topLeft: "A1", rows: [["x"]] },
    ]);
    const w = recordChanges(r.workbook, r.changed);
    expect(w.revision).toBe(2);
    expect(w.deleteCells).toEqual([{ sheetId: "s0-0", row: 0, col: 0 }]);
    expect(w.upsertCells).toContainEqual({ sheetId: "s0-0", row: 0, col: 1, input: "3", format: null });
    expect(w.upsertCells).toContainEqual({ sheetId: "s2-1", row: 0, col: 0, input: "x", format: null });
    expect(w.replaceCellsOf).toEqual(["s2-1"]);
    expect(w.upsertSheets.map((s) => s.id)).toEqual(["s2-1"]);
  });
});
