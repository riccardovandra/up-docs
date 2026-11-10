import { describe, expect, it } from "vitest";

import { formatTsv, parseTsv, pasteInputs, shiftInput, type GridClip } from "./clipboard.ts";

describe("parseTsv", () => {
  it("reads rows and fields as Google Sheets and Excel write them", () => {
    expect(parseTsv("Channel\tMonth\tOrders\r\nWeb\t2026-01\t120\r\n")).toEqual([
      ["Channel", "Month", "Orders"],
      ["Web", "2026-01", "120"],
    ]);
  });

  it("keeps blank fields and a trailing blank cell", () => {
    expect(parseTsv("a\t\tc\n\tb\t")).toEqual([
      ["a", "", "c"],
      ["", "b", ""],
    ]);
  });

  it("reads quoted fields with tabs, newlines and doubled quotes", () => {
    expect(parseTsv('"two\nlines"\t"say ""hi"""\tplain\n"tab\there"')).toEqual([
      ["two\nlines", 'say "hi"', "plain"],
      ["tab\there"],
    ]);
  });

  it("keeps a quote that does not open a quoted field", () => {
    expect(parseTsv('5" screen\t"x"y')).toEqual([['5" screen', '"x"y']]);
  });

  it("round-trips through formatTsv", () => {
    const rows = [["a\tb", 'q"uote', "line\nbreak"], ["", "x", ""]];
    expect(parseTsv(formatTsv(rows))).toEqual(rows);
  });
});

describe("pasting", () => {
  it("shifts relative references and keeps absolute ones", () => {
    expect(shiftInput("=B2*(1+C2)", 1, 0)).toBe("=B3*(1+C3)");
    expect(shiftInput("=SUMIFS(Historical!C:C,Historical!A:A,A2)", 2, 0)).toBe(
      "=SUMIFS(Historical!C:C,Historical!A:A,A4)",
    );
    expect(shiftInput("=$A$1+A1", 1, 1)).toBe("=$A$1+B2");
    expect(shiftInput("=A1", -1, 0)).toBe("=#REF!");
    expect(shiftInput("plain", 3, 3)).toBe("plain");
  });

  it("uses the grid's own copy when the clipboard still holds it", () => {
    const clip: GridClip = {
      text: "2\t4",
      inputs: [["=A1*2", "=B1*2"]],
      sheetId: "s0-0",
      row: 0,
      col: 1,
      cut: false,
    };
    expect(pasteInputs("2\t4\n", clip, { row: 1, col: 1 })).toEqual([["=A2*2", "=B2*2"]]);
    expect(pasteInputs("2\t4", { ...clip, cut: true }, { row: 5, col: 5 })).toEqual([["=A1*2", "=B1*2"]]);
    expect(pasteInputs("other", clip, { row: 1, col: 1 })).toEqual([["other"]]);
  });
});
