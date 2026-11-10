import { describe, expect, it } from "vitest";

import { compileFormula, computeAll, recalcChanged, resolveOptions } from "./recalc.ts";
import { apply, fresh, valueAt, write } from "./testing.ts";
import { cellKey } from "./types.ts";
import { recalculate } from "./workbook.ts";

describe("compileFormula", () => {
  it("collects references and volatility and caches by text", () => {
    const c = compileFormula("=SUM(A1:B2)+Other!C3+TODAY()");
    expect(c.refs.map((r) => r.sheet)).toEqual([null, "Other"]);
    expect(c.volatile).toBe(true);
    expect(compileFormula("=SUM(A1:B2)+Other!C3+TODAY()")).toBe(c);
    expect(compileFormula("=1+").ast).toBeNull();
  });
});

describe("cycles", () => {
  it("marks every cell on a cycle #CYCLE! and lets the rest compute", () => {
    const wb = write(fresh(), "Sheet1", "A1", [["=B1+1", "=A1+1", "=A1*0", "5"]]);
    expect(valueAt(wb, "Sheet1", "A1")).toEqual({ error: "#CYCLE!" });
    expect(valueAt(wb, "Sheet1", "B1")).toEqual({ error: "#CYCLE!" });
    expect(valueAt(wb, "Sheet1", "C1")).toEqual({ error: "#CYCLE!" });
    expect(valueAt(wb, "Sheet1", "D1")).toBe(5);
    const self = write(fresh(), "Sheet1", "A1", [["=A1"], ["=SUM(A:A)"]]);
    expect(valueAt(self, "Sheet1", "A1")).toEqual({ error: "#CYCLE!" });
    expect(valueAt(self, "Sheet1", "A2")).toEqual({ error: "#CYCLE!" });
  });

  it("clears the cycle once it is broken", () => {
    let wb = write(fresh(), "Sheet1", "A1", [["=B1+1", "=A1+1"]]);
    wb = write(wb, "Sheet1", "B1", [[1]]);
    expect(valueAt(wb, "Sheet1", "A1")).toBe(2);
  });

  it("handles long chains without recursion limits", () => {
    const rows = [[1], ...Array.from({ length: 4999 }, (_, i) => [`=A${i + 1}+1`])];
    let wb = fresh();
    for (let i = 0; i < rows.length; i += 1000) wb = write(wb, "Sheet1", `A${i + 1}`, rows.slice(i, i + 1000));
    expect(valueAt(wb, "Sheet1", "A5000")).toBe(5000);
    wb = write(wb, "Sheet1", "A1", [[11]]);
    expect(valueAt(wb, "Sheet1", "A5000")).toBe(5010);
  });
});

describe("incremental recalc", () => {
  it("recomputes only dependents of a change", () => {
    const wb = write(fresh(), "Sheet1", "A1", [
      [1, "=A1*2", 5, "=C1*2"],
      [2, "=SUM(A:A)", null, "=D1+1"],
    ]);
    const sheet = wb.sheets[0]!;
    const changedSheet = { ...sheet, cells: new Map(sheet.cells).set(cellKey(0, 0), { input: "10" }) };
    const r = recalcChanged(wb.calc, [changedSheet], [{ sheetId: sheet.id, key: cellKey(0, 0) }]);
    const keys = r.changed.map((c) => c.key).sort((a, b) => a - b);
    expect(keys).toEqual([cellKey(0, 0), cellKey(0, 1), cellKey(1, 1)].sort((a, b) => a - b));
    expect(r.calc.values.get(sheet.id)?.get(cellKey(1, 1))?.value).toBe(12);
    // Untouched cells keep the same computed objects; the old calc is not mutated.
    expect(r.calc.values.get(sheet.id)?.get(cellKey(0, 3))).toBe(wb.calc.values.get(sheet.id)?.get(cellKey(0, 3)));
    expect(wb.calc.values.get(sheet.id)?.get(cellKey(1, 1))?.value).toBe(3);
  });

  it("agrees with a full recompute", () => {
    let wb = write(fresh(), "Sheet1", "A1", [
      [1, "=A1+B2", "=SUM(A1:B2)"],
      [3, 4, "=C1*A2"],
    ]);
    wb = apply(wb, [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A2", rows: [[7, "=A2*2"]] },
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[null]] },
    ]).workbook;
    const full = computeAll(wb.sheets, resolveOptions());
    for (const [key, v] of full.values.get(wb.sheets[0]!.id)!) {
      expect(wb.calc.values.get(wb.sheets[0]!.id)?.get(key)?.value).toEqual(v.value);
    }
    expect(valueAt(wb, "Sheet1", "C2")).toBe(245);
  });

  it("refreshes TODAY on every edit list and on recalculate", () => {
    let now = Date.UTC(2026, 2, 15);
    let wb = write(fresh({ now: () => now }), "Sheet1", "A1", [["=TODAY()"]]);
    expect(valueAt(wb, "Sheet1", "A1")).toBe(46096);
    now += 86_400_000;
    wb = write(wb, "Sheet1", "B1", [["x"]]);
    expect(valueAt(wb, "Sheet1", "A1")).toBe(46097);
    now += 86_400_000;
    expect(valueAt(recalculate(wb), "Sheet1", "A1")).toBe(46098);
  });

  it("infers formats for formula results", () => {
    const wb = write(fresh(), "Sheet1", "A1", [["$5", "$7", "=SUM(A1:B1)", "=DATE(2026,3,15)", "=A1*2", "=A1+1"]]);
    const read = (a1: string) => wb.calc.values.get(wb.sheets[0]!.id)?.get(cellKey(0, a1.charCodeAt(0) - 65))?.pattern;
    expect(read("C")).toBe("$#,##0.00");
    expect(read("D")).toBe("yyyy-mm-dd");
    expect(read("E")).toBeNull();
    expect(read("F")).toBe("$#,##0.00");
  });
});
