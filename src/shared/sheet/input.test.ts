import { describe, expect, it } from "vitest";

import { dateToSerial, isoDate, isoDateTime, isoTime, msToSerial, serialToParts } from "./dates.ts";
import { inputFromValue, parseInput, parseNumberText } from "./input.ts";

describe("dates", () => {
  it("uses serial numbers from 1899-12-30", () => {
    expect(dateToSerial(2026, 3, 15)).toBe(46096);
    expect(dateToSerial(1899, 12, 30)).toBe(0);
    expect(dateToSerial(1900, 3, 1)).toBe(61);
    expect(dateToSerial(2026, 13, 1)).toBe(dateToSerial(2027, 1, 1));
    expect(dateToSerial(2026, 3, 0)).toBe(dateToSerial(2026, 2, 28));
    expect(serialToParts(46096.5)).toMatchObject({ year: 2026, month: 3, day: 15, hour: 12, minute: 0, weekday: 0 });
    expect(isoDate(46096)).toBe("2026-03-15");
    expect(isoTime(0.75)).toBe("18:00:00");
    expect(isoDateTime(46096.25)).toBe("2026-03-15T06:00:00");
    expect(msToSerial(Date.UTC(2026, 2, 15, 12))).toBe(46096.5);
    expect(msToSerial(Date.UTC(2026, 2, 15, 23), 120)).toBeCloseTo(46097.0417, 3);
  });
});

describe("parseInput", () => {
  it("handles blanks, formulas, text escapes and booleans", () => {
    expect(parseInput("")).toEqual({ kind: "blank" });
    expect(parseInput("=A1+1")).toEqual({ kind: "formula", formula: "=A1+1" });
    expect(parseInput("=")).toEqual({ kind: "text", value: "=" });
    expect(parseInput("'=A1")).toEqual({ kind: "text", value: "=A1" });
    expect(parseInput("'123")).toEqual({ kind: "text", value: "123" });
    expect(parseInput("TRUE")).toEqual({ kind: "boolean", value: true });
    expect(parseInput("false")).toEqual({ kind: "boolean", value: false });
    expect(parseInput("hello")).toEqual({ kind: "text", value: "hello" });
  });

  it("reads numbers as typed with implied formats", () => {
    expect(parseInput("42")).toEqual({ kind: "number", value: 42, pattern: null });
    expect(parseInput(" -3.5 ")).toEqual({ kind: "number", value: -3.5, pattern: null });
    expect(parseInput("10%")).toEqual({ kind: "number", value: 0.1, pattern: "0%" });
    expect(parseInput("12.5%")).toEqual({ kind: "number", value: 0.125, pattern: "0.0%" });
    expect(parseInput("$5")).toEqual({ kind: "number", value: 5, pattern: "$#,##0.00" });
    expect(parseInput("-$1,234.5")).toEqual({ kind: "number", value: -1234.5, pattern: "$#,##0.00" });
    expect(parseInput("€7")).toEqual({ kind: "number", value: 7, pattern: "€#,##0.00" });
    expect(parseInput("7 €")).toEqual({ kind: "number", value: 7, pattern: "€#,##0.00" });
    expect(parseInput("1,200")).toEqual({ kind: "number", value: 1200, pattern: "#,##0" });
    expect(parseInput("1,200.50")).toEqual({ kind: "number", value: 1200.5, pattern: "#,##0.00" });
    expect(parseInput("1.5e3")).toEqual({ kind: "number", value: 1500, pattern: "0.00E+00" });
    expect(parseInput(".5")).toEqual({ kind: "number", value: 0.5, pattern: null });
  });

  it("keeps malformed numbers as text", () => {
    for (const t of ["1,20", "12,34,567", "$5%", "--5", "1.2.3", "5-", "$", "%", "555-1234"]) {
      expect(parseInput(t).kind).toBe("text");
    }
  });

  it("reads dates, times and date-times", () => {
    expect(parseInput("2026-03-15")).toEqual({ kind: "number", value: 46096, pattern: "yyyy-mm-dd" });
    expect(parseInput("3/15/2026")).toEqual({ kind: "number", value: 46096, pattern: "m/d/yyyy" });
    expect(parseInput("14:30")).toEqual({ kind: "number", value: 14.5 / 24, pattern: "h:mm" });
    expect(parseInput("2:30 PM")).toEqual({ kind: "number", value: 14.5 / 24, pattern: "h:mm AM/PM" });
    expect(parseInput("12:00 am")).toEqual({ kind: "number", value: 0, pattern: "h:mm AM/PM" });
    expect(parseInput("1:02:03")).toMatchObject({ pattern: "h:mm:ss" });
    expect(parseInput("2026-03-15 06:00")).toEqual({ kind: "number", value: 46096.25, pattern: "yyyy-mm-dd h:mm" });
    expect(parseInput("2026-03-15T06:00:00")).toEqual({ kind: "number", value: 46096.25, pattern: "yyyy-mm-dd h:mm:ss" });
    for (const t of ["2026-02-30", "13/1/2026", "25:00", "1:60", "13:00 PM"]) expect(parseInput(t).kind).toBe("text");
  });

  it("parseNumberText powers coercion", () => {
    expect(parseNumberText("  1,000 ")?.value).toBe(1000);
    expect(parseNumberText("abc")).toBeNull();
    expect(parseNumberText("")).toBeNull();
  });
});

describe("inputFromValue", () => {
  it("turns edit values into typed text", () => {
    expect(inputFromValue(null)).toBeNull();
    expect(inputFromValue("")).toBeNull();
    expect(inputFromValue("x")).toBe("x");
    expect(inputFromValue(1.25)).toBe("1.25");
    expect(inputFromValue(true)).toBe("TRUE");
    expect(inputFromValue(Number.NaN)).toBeUndefined();
    expect(inputFromValue({})).toBeUndefined();
  });
});
