import { describe, expect, it } from "vitest";

import { parseRef } from "../address.ts";
import { makeCriterion, wildcardRegex } from "./criteria.ts";
import { offsetRelative, rewriteFormula, shiftForDelete, shiftForInsert } from "./rewrite.ts";

const ref = (t: string) => parseRef(t)!;

describe("shiftForInsert", () => {
  it("moves bounds at or past the insert point", () => {
    expect(shiftForInsert(ref("A5"), "row", 2, 3)).toMatchObject({ startRow: 7, endRow: 7 });
    expect(shiftForInsert(ref("A1"), "row", 2, 3)).toBeNull();
    expect(shiftForInsert(ref("A1:A5"), "row", 2, 3)).toMatchObject({ startRow: 0, endRow: 7 });
    expect(shiftForInsert(ref("A1:A2"), "row", 2, 3)).toBeNull();
    expect(shiftForInsert(ref("C:C"), "row", 0, 3)).toBeNull();
    expect(shiftForInsert(ref("C:D"), "col", 3, 1)).toMatchObject({ startCol: 2, endCol: 4 });
    expect(shiftForInsert(ref("$B$2"), "col", 0, 1)).toMatchObject({ startCol: 2, startColAbsolute: true });
  });
});

describe("shiftForDelete", () => {
  it("turns deleted single cells into #REF! and shrinks ranges", () => {
    expect(shiftForDelete(ref("A3"), "row", 2, 1)).toBe("#REF!");
    expect(shiftForDelete(ref("A5"), "row", 2, 1)).toMatchObject({ startRow: 3 });
    expect(shiftForDelete(ref("A1"), "row", 2, 1)).toBeNull();
    expect(shiftForDelete(ref("A1:A5"), "row", 2, 1)).toMatchObject({ startRow: 0, endRow: 3 });
    expect(shiftForDelete(ref("A3:A4"), "row", 2, 2)).toBe("#REF!");
    expect(shiftForDelete(ref("A3:A6"), "row", 1, 3)).toMatchObject({ startRow: 1, endRow: 2 });
    expect(shiftForDelete(ref("F2:F"), "row", 0, 1)).toMatchObject({ startRow: 0, endRow: null });
    expect(shiftForDelete(ref("B:B"), "col", 1, 1)).toBe("#REF!");
    expect(shiftForDelete(ref("B:D"), "col", 1, 1)).toMatchObject({ startCol: 1, endCol: 2 });
  });
});

describe("offsetRelative", () => {
  it("moves relative bounds only", () => {
    expect(offsetRelative(ref("B2"), "row", 3)).toMatchObject({ startRow: 4 });
    expect(offsetRelative(ref("B$2"), "row", 3)).toBeNull();
    expect(offsetRelative(ref("B2"), "row", -5)).toBe("#REF!");
    expect(offsetRelative(ref("C:C"), "row", 2)).toBeNull();
  });
});

describe("rewriteFormula", () => {
  it("splices only changed references and keeps the rest as typed", () => {
    const shift = (r: ReturnType<typeof ref>) => shiftForInsert(r, "row", 1, 1);
    expect(rewriteFormula("=SUM( A1:A3 ) +  b2*2", shift)).toBe("=SUM( A1:A4 ) +  B3*2");
    expect(rewriteFormula("=A1+1", shift)).toBeNull();
    expect(rewriteFormula("=A2+\"A2\"", shift)).toBe("=A3+\"A2\"");
    expect(rewriteFormula("=A2+1", () => "#REF!")).toBe("=#REF!+1");
    expect(rewriteFormula("=Data!A1", (r) => ({ ...r, sheet: "My data" }))).toBe("='My data'!A1");
    expect(rewriteFormula("plain", shift)).toBeNull();
  });
});

describe("criteria", () => {
  it("builds wildcard regexes with escapes", () => {
    expect(wildcardRegex("a*c").test("ABBC")).toBe(true);
    expect(wildcardRegex("a?c").test("abbc")).toBe(false);
    expect(wildcardRegex("a~*").test("a*")).toBe(true);
    expect(wildcardRegex("a~*").test("ab")).toBe(false);
    expect(wildcardRegex("1.5").test("105")).toBe(false);
  });

  it("matches values like Sheets", () => {
    expect(makeCriterion(">10")(11)).toBe(true);
    expect(makeCriterion(">10")("11x")).toBe(false);
    expect(makeCriterion("<>x")(null)).toBe(true);
    expect(makeCriterion("=")(null)).toBe(true);
    expect(makeCriterion("=")("a")).toBe(false);
    expect(makeCriterion("10")("10")).toBe(true);
    expect(makeCriterion(10)(10)).toBe(true);
    expect(makeCriterion(true)(true)).toBe(true);
    expect(makeCriterion("TRUE")(true)).toBe(true);
    expect(makeCriterion(">b")("c")).toBe(true);
    expect(makeCriterion(">=50%")(0.5)).toBe(true);
    expect(makeCriterion({ error: "#N/A" })({ error: "#N/A" })).toBe(true);
  });
});
