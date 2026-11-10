import { describe, expect, it } from "vitest";

import {
  areaContains,
  columnToLetters,
  formatArea,
  formatCellAddress,
  formatRef,
  lettersToColumn,
  parseArea,
  parseCellAddress,
  parseColumnSpan,
  parseRef,
  parseRowSpan,
  quoteSheetName,
} from "./address.ts";

describe("column letters", () => {
  it("converts both ways", () => {
    for (const [n, s] of [
      [0, "A"],
      [25, "Z"],
      [26, "AA"],
      [701, "ZZ"],
      [702, "AAA"],
      [18277, "ZZZ"],
    ] as const) {
      expect(columnToLetters(n)).toBe(s);
      expect(lettersToColumn(s)).toBe(n);
    }
    expect(lettersToColumn("ab")).toBe(27);
    expect(lettersToColumn("AAAA")).toBe(-1);
    expect(lettersToColumn("1")).toBe(-1);
  });
});

describe("parseRef", () => {
  it("parses cells with and without $", () => {
    expect(parseRef("B3")).toMatchObject({ sheet: null, startRow: 2, startCol: 1, endRow: 2, endCol: 1, single: true });
    expect(parseRef("$B$3")).toMatchObject({ startRowAbsolute: true, startColAbsolute: true, single: true });
    expect(parseRef("B$3")).toMatchObject({ startRowAbsolute: true, startColAbsolute: false });
  });

  it("parses ranges, normalizing reversed corners", () => {
    expect(parseRef("A1:C4")).toMatchObject({ startRow: 0, startCol: 0, endRow: 3, endCol: 2, single: false });
    expect(parseRef("C4:A1")).toMatchObject({ startRow: 0, startCol: 0, endRow: 3, endCol: 2 });
  });

  it("parses whole columns, whole rows and open ranges", () => {
    expect(parseRef("C:C")).toMatchObject({ startRow: null, endRow: null, startCol: 2, endCol: 2 });
    expect(parseRef("$A:$B")).toMatchObject({ startColAbsolute: true, endColAbsolute: true, startCol: 0, endCol: 1 });
    expect(parseRef("2:2")).toMatchObject({ startRow: 1, endRow: 1, startCol: null, endCol: null });
    expect(parseRef("$2:$5")).toMatchObject({ startRow: 1, endRow: 4, startRowAbsolute: true, endRowAbsolute: true });
    expect(parseRef("F2:F")).toMatchObject({ startRow: 1, endRow: null, startCol: 5, endCol: 5 });
  });

  it("parses sheet prefixes, bare and quoted", () => {
    expect(parseRef("Historical!C:C")).toMatchObject({ sheet: "Historical", startCol: 2 });
    expect(parseRef("'My tab'!A1")).toMatchObject({ sheet: "My tab", startRow: 0 });
    expect(parseRef("'Bob''s'!A1")).toMatchObject({ sheet: "Bob's" });
  });

  it("rejects what is not a reference", () => {
    for (const bad of ["", "A", "1", "A0", "AAAA1", "A1:", "A$", "SUM", "A1:2", "A:1"]) expect(parseRef(bad)).toBeNull();
  });

  it("formats back to text", () => {
    for (const text of ["A1", "$A$1", "A1:B2", "C:C", "2:2", "F2:F", "$A:$B", "Historical!C:C", "'My tab'!A1:B2", "'Bob''s'!A1"]) {
      expect(formatRef(parseRef(text)!)).toBe(text);
    }
  });
});

describe("sheet name quoting", () => {
  it("quotes only when needed", () => {
    expect(quoteSheetName("Historical")).toBe("Historical");
    expect(quoteSheetName("Sheet_2")).toBe("Sheet_2");
    expect(quoteSheetName("My tab")).toBe("'My tab'");
    expect(quoteSheetName("A1")).toBe("'A1'");
    expect(quoteSheetName("TRUE")).toBe("'TRUE'");
    expect(quoteSheetName("2026")).toBe("'2026'");
    expect(quoteSheetName("it's")).toBe("'it''s'");
  });
});

describe("edit addresses", () => {
  it("parses cells and areas without sheet prefixes", () => {
    expect(parseCellAddress("C10")).toEqual({ row: 9, col: 2 });
    expect(parseCellAddress("A1:B2")).toBeNull();
    expect(parseCellAddress("Sheet1!A1")).toBeNull();
    expect(parseArea("A1:B2")).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(parseArea("B2")).toEqual({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
    expect(parseArea("Sheet1!A1")).toBeNull();
    expect(formatCellAddress(9, 2)).toBe("C10");
    expect(formatArea({ startRow: 0, startCol: 0, endRow: 3, endCol: 3 })).toBe("A1:D4");
    expect(formatArea({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 })).toBe("B2");
  });

  it("parses row and column spans", () => {
    expect(parseRowSpan(3)).toEqual([2, 2]);
    expect(parseRowSpan("3:5")).toEqual([2, 4]);
    expect(parseRowSpan("5:3")).toEqual([2, 4]);
    expect(parseRowSpan(0)).toBeNull();
    expect(parseRowSpan(1.5)).toBeNull();
    expect(parseColumnSpan("C")).toEqual([2, 2]);
    expect(parseColumnSpan("c:e")).toEqual([2, 4]);
    expect(parseColumnSpan("C1")).toBeNull();
  });

  it("tests containment with open bounds", () => {
    const col = parseRef("C:C")!;
    expect(areaContains(col, 999, 2)).toBe(true);
    expect(areaContains(col, 0, 3)).toBe(false);
    const open = parseRef("F2:F")!;
    expect(areaContains(open, 0, 5)).toBe(false);
    expect(areaContains(open, 5000, 5)).toBe(true);
  });
});
