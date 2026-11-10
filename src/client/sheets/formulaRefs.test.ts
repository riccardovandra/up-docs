import { describe, expect, it } from "vitest";

import { formulaRefSpans, pickedRefText, putRef, refInsertion, refRect, REF_COLORS } from "./formulaRefs.ts";

const dims = { rows: 1000, cols: 26 };

describe("formulaRefSpans", () => {
  it("colours each reference, the same one alike", () => {
    const spans = formulaRefSpans("=B2*(1+C2)+b2");
    expect(spans.map((span) => "=B2*(1+C2)+b2".slice(span.start, span.end))).toEqual(["B2", "C2", "b2"]);
    expect(spans[0]?.color).toBe(REF_COLORS[0]);
    expect(spans[1]?.color).toBe(REF_COLORS[1]);
    expect(spans[2]?.color).toBe(REF_COLORS[0]);
  });

  it("finds cross-tab and whole-column references, not function names", () => {
    const input = "=SUMIFS(Historical!C:C,Historical!A:A,A2)";
    const spans = formulaRefSpans(input);
    expect(spans.map((span) => input.slice(span.start, span.end))).toEqual([
      "Historical!C:C",
      "Historical!A:A",
      "A2",
    ]);
    expect(refRect(spans[0]!.ref, "Historical", "Pre-orders", dims)).toEqual({ r1: 0, c1: 2, r2: 999, c2: 2 });
    expect(refRect(spans[0]!.ref, "Pre-orders", "Pre-orders", dims)).toBeNull();
    expect(refRect(spans[2]!.ref, "Pre-orders", "Pre-orders", dims)).toEqual({ r1: 1, c1: 0, r2: 1, c2: 0 });
  });

  it("is empty for plain input", () => {
    expect(formulaRefSpans("B2")).toEqual([]);
  });
});

describe("point mode", () => {
  it("inserts after an operator, a bracket or a comma", () => {
    expect(refInsertion("=", 1, null)).toEqual({ start: 1, end: 1 });
    expect(refInsertion("=SUM(", 5, null)).toEqual({ start: 5, end: 5 });
    expect(refInsertion("=A1+ ", 5, null)).toEqual({ start: 5, end: 5 });
    expect(refInsertion("=A1", 3, null)).toBeNull();
    expect(refInsertion("hello", 5, null)).toBeNull();
  });

  it("replaces the reference picked just before", () => {
    const first = putRef("=SUM(", { start: 5, end: 5 }, "B2");
    expect(first).toEqual({ input: "=SUM(B2", span: { start: 5, end: 7 } });
    const span = refInsertion(first.input, 7, first.span);
    expect(span).toEqual({ start: 5, end: 7 });
    expect(putRef(first.input, span!, "B2:B9").input).toBe("=SUM(B2:B9");
  });

  it("prefixes a reference to another tab", () => {
    const rect = { r1: 0, c1: 2, r2: 9, c2: 2 };
    expect(pickedRefText(rect, "Historical", "Pre-orders")).toBe("Historical!C1:C10");
    expect(pickedRefText(rect, "My tab", "Pre-orders")).toBe("'My tab'!C1:C10");
    expect(pickedRefText({ r1: 1, c1: 1, r2: 1, c2: 1 }, "Pre-orders", "pre-orders")).toBe("B2");
  });
});
