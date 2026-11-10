import { describe, expect, it } from "vitest";

import { workbookFromRecords, workbookToRecords } from "./serialize.ts";
import { apply, fresh, shownAt, valueAt } from "./testing.ts";
import { applyEdits, isRefusal, readCells, readSheets } from "./workbook.ts";

// The brief's example: Historical rows (Channel, Month, Orders) and a Forecast
// tab that sums them per channel, grows them by a typed percent and totals.
function forecastWorkbook() {
  let wb = fresh();
  wb = apply(wb, [
    { kind: "renameSheet", sheet: "Sheet1", name: "Historical" },
    {
      kind: "writeCells",
      sheet: "Historical",
      topLeft: "A1",
      rows: [
        ["Channel", "Month", "Orders"],
        ["Email", "2026-01-01", 120],
        ["Ads", "2026-01-01", 80],
        ["Email", "2026-02-01", 130],
        ["Ads", "2026-02-01", 95],
      ],
    },
    { kind: "addSheet", name: "Forecast" },
    {
      kind: "writeCells",
      sheet: "Forecast",
      topLeft: "A1",
      rows: [
        ["Channel", "Actual", "Growth", "Next"],
        ["Email", "=SUMIFS(Historical!C:C,Historical!A:A,A2)", "10%", "=B2*(1+C2)"],
        ["Ads", "=SUMIFS(Historical!C:C,Historical!A:A,A3)", "5%", "=B3*(1+C3)"],
        ["Total", "=SUM(B2:B3)", null, "=SUM(D2:D3)"],
      ],
    },
  ]).workbook;
  return wb;
}

describe("forecast example end to end", () => {
  it("computes SUMIFS across tabs, typed percents and totals", () => {
    const wb = forecastWorkbook();
    expect(valueAt(wb, "Forecast", "B2")).toBe(250);
    expect(valueAt(wb, "Forecast", "B3")).toBe(175);
    expect(valueAt(wb, "Forecast", "C2")).toBe(0.1);
    expect(shownAt(wb, "Forecast", "C2")).toBe("10%");
    expect(valueAt(wb, "Forecast", "D2")).toBeCloseTo(275, 10);
    expect(valueAt(wb, "Forecast", "D3")).toBeCloseTo(183.75, 10);
    expect(valueAt(wb, "Forecast", "B4")).toBe(425);
    expect(valueAt(wb, "Forecast", "D4")).toBeCloseTo(458.75, 10);
    expect(valueAt(wb, "Historical", "B2")).toBe(46023);
  });

  it("reads cells in the Claude Sheets shape", () => {
    const wb = forecastWorkbook();
    const r = readCells(wb, "Forecast", "A1:D4");
    if (isRefusal(r)) throw new Error(r.detail);
    expect(r.range).toBe("A1:D4");
    expect(r.rows[1]).toEqual([
      "Email",
      { formula: "=SUMIFS(Historical!C:C,Historical!A:A,A2)", value: 250 },
      { number: 0.1, shown: "10%" },
      { formula: "=B2*(1+C2)", value: 275 },
    ]);
    expect(r.rows[3]?.[2]).toBe(null);
    const h = readCells(wb, "Historical", "B2");
    if (isRefusal(h)) throw new Error(h.detail);
    expect(h.rows).toEqual([[{ date: "2026-01-01" }]]);
  });

  it("recomputes dependents when an input changes, across sheets", () => {
    const wb = forecastWorkbook();
    const r = apply(wb, [{ kind: "writeCells", sheet: "Historical", topLeft: "C2", rows: [[220]] }]);
    expect(valueAt(r.workbook, "Forecast", "B2")).toBe(350);
    expect(valueAt(r.workbook, "Forecast", "B4")).toBe(525);
    const forecast = r.workbook.sheets[1]?.id;
    const changedValues = r.changed.values.filter((p) => p.sheetId === forecast).map((p) => `${p.row},${p.col}`);
    expect(changedValues.sort()).toEqual(["1,1", "1,3", "3,1", "3,3"]);
    // The old workbook is untouched.
    expect(valueAt(wb, "Forecast", "B2")).toBe(250);
  });

  it("keeps working after inserting a row and renaming the source tab", () => {
    let wb = forecastWorkbook();
    wb = apply(wb, [
      { kind: "insertRows", sheet: "Forecast", besideRow: 3, side: "after", count: 1 },
      { kind: "writeCells", sheet: "Forecast", topLeft: "A4", rows: [["Social", "=SUMIFS(Historical!C:C,Historical!A:A,A4)", "0%", "=B4*(1+C4)"]] },
      { kind: "renameSheet", sheet: "Historical", name: "Past orders" },
    ]).workbook;
    expect(valueAt(wb, "Forecast", "B5")).toBe(425);
    const r = readCells(wb, "Forecast", "B2");
    if (isRefusal(r)) throw new Error(r.detail);
    expect(r.rows[0]?.[0]).toEqual({ formula: "=SUMIFS('Past orders'!C:C,'Past orders'!A:A,A2)", value: 250 });
    const total = readCells(wb, "Forecast", "B5");
    if (isRefusal(total)) throw new Error(total.detail);
    expect(total.rows[0]?.[0]).toEqual({ formula: "=SUM(B2:B3)", value: 425 });
  });

  it("round-trips through storage records", () => {
    const wb = forecastWorkbook();
    const back = workbookFromRecords(workbookToRecords(wb), { now: () => 0 });
    expect(readSheets(back)).toEqual(readSheets(wb));
    expect(valueAt(back, "Forecast", "D4")).toBeCloseTo(458.75, 10);
    const again = applyEdits(back, back.revision, [{ kind: "writeCells", sheet: "Forecast", topLeft: "C2", rows: [["20%"]] }]);
    if (isRefusal(again)) throw new Error(again.detail);
    expect(valueAt(again.workbook, "Forecast", "D2")).toBeCloseTo(300, 10);
  });
});
