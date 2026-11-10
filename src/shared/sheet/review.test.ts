import { describe, expect, it } from "vitest";

import { apply, fresh, valueAt, write } from "./testing.ts";

// Regressions from the sol-loop review of the engine.
describe("review regressions", () => {
  it("recomputes open ranges when a write grows the sheet", () => {
    let wb = write(fresh(), "Sheet1", "B1", [["=COUNTBLANK(A:A)"]]);
    expect(valueAt(wb, "Sheet1", "B1")).toBe(1000);
    wb = write(wb, "Sheet1", "C1001", [["x"]]);
    expect(valueAt(wb, "Sheet1", "B1")).toBe(1001);
  });

  it("returns #REF! from range arguments of a deleted sheet", () => {
    let wb = apply(fresh(), [
      { kind: "addSheet", name: "Data" },
      { kind: "writeCells", sheet: "Data", topLeft: "A1", rows: [[5]] },
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [['=COUNTIF(Data!A:A,">0")', '=SUMIF(Data!A:A,">0")', "=MATCH(5,Data!A:A,0)"]] },
    ]).workbook;
    expect(valueAt(wb, "Sheet1", "A1")).toBe(1);
    wb = apply(wb, [{ kind: "deleteSheet", sheet: "Data" }]).workbook;
    for (const a1 of ["A1", "B1", "C1"]) expect(valueAt(wb, "Sheet1", a1)).toEqual({ error: "#REF!" });
  });

  it("tracks the cells a resized SUMIF target really reads", () => {
    let wb = write(fresh(), "Sheet1", "A1", [
      ["x", 1, '=SUMIF(A1:A2,"x",B1)'],
      ["x", 2],
    ]);
    expect(valueAt(wb, "Sheet1", "C1")).toBe(3);
    wb = write(wb, "Sheet1", "B2", [[9]]);
    expect(valueAt(wb, "Sheet1", "C1")).toBe(10);
  });

  it("refreshes TODAY on metadata-only edit lists", () => {
    let now = Date.UTC(2026, 2, 15);
    let wb = write(fresh({ now: () => now }), "Sheet1", "A1", [["=TODAY()"]]);
    now += 86_400_000;
    const r = apply(wb, [{ kind: "setSheetSettings", sheet: "Sheet1", settings: { areGridlinesHidden: true } }]);
    wb = r.workbook;
    expect(valueAt(wb, "Sheet1", "A1")).toBe(46097);
    expect(r.changed.values).toEqual([{ sheetId: "s0-0", row: 0, col: 0 }]);
  });
});
