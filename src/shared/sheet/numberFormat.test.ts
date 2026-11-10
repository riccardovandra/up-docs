import { describe, expect, it } from "vitest";

import { decreaseDecimals, display, formatGeneral, increaseDecimals, patternKind } from "./numberFormat.ts";

describe("display", () => {
  it("shows general numbers", () => {
    expect(display(42)).toBe("42");
    expect(display(0.1 + 0.2)).toBe("0.3");
    expect(display(1 / 3)).toBe("0.3333333333");
    expect(display(-2.5)).toBe("-2.5");
    expect(display(1234567.891)).toBe("1234567.891");
    expect(display(1e20)).toBe("1.00E+20");
    expect(formatGeneral(0)).toBe("0");
  });

  it("shows non-numbers", () => {
    expect(display(null)).toBe("");
    expect(display(true)).toBe("TRUE");
    expect(display("hi", "0.00")).toBe("hi");
    expect(display({ error: "#REF!" })).toBe("#REF!");
  });

  it("applies number patterns", () => {
    expect(display(3.14159, "0")).toBe("3");
    expect(display(2.5, "0")).toBe("3");
    expect(display(-2.5, "0")).toBe("-3");
    expect(display(3.14159, "0.00")).toBe("3.14");
    expect(display(1.005, "0.00")).toBe("1.01");
    expect(display(1234567.5, "#,##0")).toBe("1,234,568");
    expect(display(1234.5, "#,##0.00")).toBe("1,234.50");
    expect(display(0.1, "0%")).toBe("10%");
    expect(display(0.125, "0.0%")).toBe("12.5%");
    expect(display(5, "$#,##0.00")).toBe("$5.00");
    expect(display(-1234.5, "$#,##0.00")).toBe("-$1,234.50");
    expect(display(7, "€#,##0.00")).toBe("€7.00");
    expect(display(7, '[$€]#,##0.00')).toBe("€7.00");
    expect(display(0.5, "#.##")).toBe(".5");
    expect(display(12345, "0.00E+00")).toBe("1.23E+04");
    expect(display(1234567, "#,##0,")).toBe("1,235");
    expect(display(5, '0" units"')).toBe("5 units");
    expect(display(-0.001, "0.00")).toBe("0.00");
  });

  it("uses positive;negative;zero sections", () => {
    expect(display(-5, "0;(0)")).toBe("(5)");
    expect(display(5, "0;(0)")).toBe("5");
    expect(display(0, '0;(0);"-"')).toBe("-");
    expect(display("x", '0;0;0;"<"@">"')).toBe("<x>");
  });

  it("applies date and time patterns", () => {
    expect(display(46096, "yyyy-mm-dd")).toBe("2026-03-15");
    expect(display(46096, "m/d/yyyy")).toBe("3/15/2026");
    expect(display(46096, "mmm d, yyyy")).toBe("Mar 15, 2026");
    expect(display(46096, "dddd mmmm d")).toBe("Sunday March 15");
    expect(display(46096, "dd/mm/yy")).toBe("15/03/26");
    expect(display(14.5 / 24, "h:mm")).toBe("14:30");
    expect(display(14.5 / 24, "h:mm AM/PM")).toBe("2:30 PM");
    expect(display(0, "h:mm AM/PM")).toBe("12:00 AM");
    expect(display(46096.25, "yyyy-mm-dd hh:mm:ss")).toBe("2026-03-15 06:00:00");
    expect(display(1.5, "[h]:mm")).toBe("36:00");
  });

  it("classifies patterns", () => {
    expect(patternKind(null)).toBe("number");
    expect(patternKind("0.00%")).toBe("number");
    expect(patternKind("yyyy-mm-dd")).toBe("date");
    expect(patternKind("m/d/yyyy")).toBe("date");
    expect(patternKind("h:mm")).toBe("time");
    expect(patternKind("mm:ss")).toBe("time");
    expect(patternKind("yyyy-mm-dd h:mm")).toBe("dateTime");
    expect(patternKind("@")).toBe("text");
  });
});

describe("decimals helpers", () => {
  it("adds and removes decimal places", () => {
    expect(increaseDecimals("0", 1)).toBe("0.0");
    expect(increaseDecimals("0.00", 1)).toBe("0.000");
    expect(increaseDecimals("#,##0", 1)).toBe("#,##0.0");
    expect(increaseDecimals("0%", 1)).toBe("0.0%");
    expect(increaseDecimals("$#,##0.00", 1)).toBe("$#,##0.000");
    expect(increaseDecimals("0;(0)", 1)).toBe("0.0;(0.0)");
    expect(decreaseDecimals("0.00", 1)).toBe("0.0");
    expect(decreaseDecimals("0.0", 1)).toBe("0");
    expect(decreaseDecimals("0", 1)).toBe("0");
    expect(decreaseDecimals("0.0%", 1)).toBe("0%");
    expect(decreaseDecimals("$#,##0.00", 1)).toBe("$#,##0.0");
  });

  it("starts from what a general cell shows and leaves dates alone", () => {
    expect(increaseDecimals(null, 1.5)).toBe("0.00");
    expect(increaseDecimals(null, 3)).toBe("0.0");
    expect(decreaseDecimals(null, 1.25)).toBe("0.0");
    expect(decreaseDecimals(null, 1.5)).toBe("0");
    expect(increaseDecimals("yyyy-mm-dd", 46096)).toBe("yyyy-mm-dd");
  });
});
