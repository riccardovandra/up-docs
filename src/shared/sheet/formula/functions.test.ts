import { describe, expect, it } from "vitest";

import { calc, fresh, write } from "../testing.ts";
import type { Workbook } from "../types.ts";

// A small table on Sheet1: A=name, B=region, C=amount, D=date.
function table(): Workbook {
  return write(fresh(), "Sheet1", "A1", [
    ["Name", "Region", "Amount", "When"],
    ["Ann", "North", 10, "2026-01-15"],
    ["Bob", "South", 20, "2026-02-15"],
    ["Cid", "North", 30, "2026-03-15"],
    ["Dee", "East", "n/a", "2026-03-20"],
    ["Eve", "South", 40, null],
  ]);
}

const wb = table();
const f = (formula: string) => calc(wb, formula);

describe("operators", () => {
  it("does arithmetic, text and comparisons", () => {
    expect(f("=1+2*3")).toBe(7);
    expect(f("=-2^2")).toBe(4);
    expect(f("=2^3^2")).toBe(64);
    expect(f("=10/4")).toBe(2.5);
    expect(f("=50%*4")).toBe(2);
    expect(f('="a"&1&TRUE')).toBe("a1TRUE");
    expect(f('="10"+5')).toBe(15);
    expect(f("=A2+1")).toEqual({ error: "#VALUE!" });
    expect(f('="abc"="ABC"')).toBe(true);
    expect(f("=1<\"a\"")).toBe(true);
    expect(f("=Z999=0")).toBe(true);
    expect(f("=Z999&\"x\"")).toBe("x");
    expect(f("=1/0")).toEqual({ error: "#DIV/0!" });
    expect(f("=0^-1")).toEqual({ error: "#DIV/0!" });
    expect(f("=(-8)^0.5")).toEqual({ error: "#NUM!" });
    expect(f("=C2:C3")).toEqual({ error: "#VALUE!" });
    expect(f("=C2")).toBe(10);
  });

  it("propagates errors and names", () => {
    expect(f("=#N/A+1")).toEqual({ error: "#N/A" });
    expect(f("=NOPE(1)")).toEqual({ error: "#NAME?" });
    expect(f("=foo+1")).toEqual({ error: "#NAME?" });
    expect(f("=Missing!A1")).toEqual({ error: "#REF!" });
    expect(f("=SUM()")).toEqual({ error: "#N/A" });
    expect(f("=1+")).toEqual({ error: "#ERROR!" });
  });
});

describe("aggregates", () => {
  it("sums, averages and counts, skipping text in ranges", () => {
    expect(f("=SUM(C2:C6)")).toBe(100);
    expect(f("=SUM(C:C)")).toBe(100);
    expect(f("=SUM(C2:C6, 5, TRUE)")).toBe(106);
    expect(f('=SUM("x")')).toEqual({ error: "#VALUE!" });
    expect(f("=SUM(A2)")).toBe(0);
    expect(f("=AVERAGE(C2:C6)")).toBe(25);
    expect(f("=AVERAGE(A2:A3)")).toEqual({ error: "#DIV/0!" });
    expect(f("=MIN(C2:C6)")).toBe(10);
    expect(f("=MAX(C2:C6)")).toBe(40);
    expect(f("=MAX(A2:A3)")).toBe(0);
    expect(f("=MEDIAN(C2:C6)")).toBe(25);
    expect(f("=MEDIAN(1,2,3)")).toBe(2);
    expect(f("=PRODUCT(C2:C3, 2)")).toBe(400);
    expect(f("=COUNT(C2:C6)")).toBe(4);
    expect(f('=COUNT(1,"2","x",TRUE)')).toBe(3);
    expect(f("=COUNTA(A1:D6)")).toBe(23);
    expect(f("=COUNTBLANK(D2:D7)")).toBe(2);
    expect(f("=SUM(C2:C6/0)")).toEqual({ error: "#VALUE!" });
  });

  it("rounds half away from zero", () => {
    expect(f("=ROUND(2.5)")).toBe(3);
    expect(f("=ROUND(-2.5)")).toBe(-3);
    expect(f("=ROUND(1.005, 2)")).toBe(1.01);
    expect(f("=ROUND(1234, -2)")).toBe(1200);
    expect(f("=ROUNDUP(1.21, 1)")).toBe(1.3);
    expect(f("=ROUNDUP(-1.21, 1)")).toBe(-1.3);
    expect(f("=ROUNDDOWN(1.29, 1)")).toBe(1.2);
    expect(f("=ABS(-3)")).toBe(3);
  });
});

describe("logic", () => {
  it("evaluates IF, IFS, IFERROR, IFNA, AND, OR, NOT", () => {
    expect(f('=IF(C2>5,"big","small")')).toBe("big");
    expect(f("=IF(FALSE,1)")).toBe(false);
    expect(f('=IFS(C2>50,"a",C2>5,"b")')).toBe("b");
    expect(f("=IFS(FALSE,1)")).toEqual({ error: "#N/A" });
    expect(f("=IFERROR(1/0, 9)")).toBe(9);
    expect(f("=IFERROR(1/0)")).toBe("");
    expect(f("=IFERROR(4, 9)")).toBe(4);
    expect(f("=IFNA(#N/A, 1)")).toBe(1);
    expect(f("=IFNA(1/0, 1)")).toEqual({ error: "#DIV/0!" });
    expect(f("=AND(TRUE, C2>5)")).toBe(true);
    expect(f("=AND(TRUE, 0)")).toBe(false);
    expect(f("=OR(FALSE, 0, C2:C3)")).toBe(true);
    expect(f("=AND(A2:A3)")).toEqual({ error: "#VALUE!" });
    expect(f("=NOT(1)")).toBe(false);
    expect(f('=IF("x",1,2)')).toEqual({ error: "#VALUE!" });
  });
});

describe("conditional aggregates", () => {
  it("matches criteria with operators and wildcards", () => {
    expect(f('=SUMIF(B2:B6,"North",C2:C6)')).toBe(40);
    expect(f('=SUMIF(C2:C6,">15")')).toBe(90);
    expect(f('=SUMIF(B:B,"north",C:C)')).toBe(40);
    expect(f('=SUMIFS(C:C,B:B,"South",C:C,">25")')).toBe(40);
    expect(f('=SUMIFS(C2:C6,B2:B5,"South")')).toEqual({ error: "#VALUE!" });
    expect(f('=COUNTIF(B2:B6,"*th")')).toBe(4);
    expect(f('=COUNTIF(A2:A6,"?ve")')).toBe(1);
    expect(f('=COUNTIF(C2:C6,"<>20")')).toBe(4);
    expect(f('=COUNTIF(D2:D7,"")')).toBe(2);
    expect(f('=COUNTIF(D2:D7,"<>")')).toBe(4);
    expect(f('=COUNTIF(D2:D6,">=2026-03-01")')).toBe(2);
    expect(f('=COUNTIFS(B2:B6,"South",C2:C6,">=20")')).toBe(2);
    expect(f("=COUNTIF(C2:C6,10)")).toBe(1);
    expect(f('=AVERAGEIF(B2:B6,"South",C2:C6)')).toBe(30);
    expect(f('=AVERAGEIF(B2:B6,"West",C2:C6)')).toEqual({ error: "#DIV/0!" });
    expect(f('=AVERAGEIFS(C2:C6,B2:B6,"North",C2:C6,"<25")')).toBe(10);
  });

  it("counts blank cells past the filled area of whole columns", () => {
    // Z:Z is empty; the sheet has 1000 rows, the scratch cell Z1000 holds the formula itself.
    expect(f('=COUNTIF(Y:Y,"")')).toBe(1000);
    expect(f('=COUNTIF(B:B,"<>South")')).toBe(998);
  });
});

describe("lookups", () => {
  it("VLOOKUP and HLOOKUP, exact and sorted", () => {
    expect(f('=VLOOKUP("cid",A2:C6,3,FALSE)')).toBe(30);
    expect(f('=VLOOKUP("C*",A2:C6,2,FALSE)')).toBe("North");
    expect(f('=VLOOKUP("Zed",A2:C6,3,FALSE)')).toEqual({ error: "#N/A" });
    expect(f('=VLOOKUP("Ann",A2:C6,4,FALSE)')).toEqual({ error: "#REF!" });
    expect(f('=VLOOKUP("Ann",A2:C6,0,FALSE)')).toEqual({ error: "#VALUE!" });
    expect(f("=VLOOKUP(25,C2:C3,1)")).toBe(20);
    expect(f("=VLOOKUP(5,C2:C3,1,TRUE)")).toEqual({ error: "#N/A" });
    expect(f('=HLOOKUP("Amount",A1:D6,3,FALSE)')).toBe(20);
  });

  it("XLOOKUP with missing values, match modes and search order", () => {
    expect(f('=XLOOKUP("Bob",A2:A6,C2:C6)')).toBe(20);
    expect(f('=XLOOKUP("Zed",A2:A6,C2:C6,"none")')).toBe("none");
    expect(f('=XLOOKUP("Zed",A2:A6,C2:C6)')).toEqual({ error: "#N/A" });
    expect(f('=XLOOKUP("South",B2:B6,A2:A6,,0,-1)')).toBe("Eve");
    expect(f("=XLOOKUP(25,C2:C3,A2:A3,,-1)")).toBe("Bob");
    expect(f("=XLOOKUP(25,C2:C6,A2:A6,,1)")).toBe("Cid");
    expect(f('=XLOOKUP("E*",A2:A6,C2:C6,,2)')).toBe(40);
    expect(f('=SUM(XLOOKUP("Bob",A2:A6,B2:C6))')).toBe(20);
    expect(f('=XLOOKUP("Bob",A2:A6,C2:C5)')).toEqual({ error: "#VALUE!" });
  });

  it("INDEX and MATCH", () => {
    expect(f("=INDEX(A1:D6,3,1)")).toBe("Bob");
    expect(f("=INDEX(C2:C6,2)")).toBe(20);
    expect(f("=INDEX(A1:D1,3)")).toBe("Amount");
    expect(f("=SUM(INDEX(A2:C6,0,3))")).toBe(100);
    expect(f("=SUM(INDEX(C2:D3,1,0))")).toBe(46047);
    expect(f("=INDEX(A1:D6,9,1)")).toEqual({ error: "#REF!" });
    expect(f('=MATCH("cid",A2:A6,0)')).toBe(3);
    expect(f('=MATCH("c?d",A2:A6,0)')).toBe(3);
    expect(f("=MATCH(25,C2:C3)")).toBe(2);
    expect(f("=MATCH(5,C2:C3,1)")).toEqual({ error: "#N/A" });
    expect(f('=MATCH("x",A2:A6,0)')).toEqual({ error: "#N/A" });
    expect(f("=MATCH(1,A1:B2,0)")).toEqual({ error: "#N/A" });
    expect(f('=INDEX(C2:C6,MATCH("Eve",A2:A6,0))')).toBe(40);
  });
});

describe("text", () => {
  it("joins, slices and changes case", () => {
    expect(f('=CONCAT("a",1)')).toBe("a1");
    expect(f("=CONCATENATE(A2:A3)")).toBe("AnnBob");
    expect(f('=TEXTJOIN(", ",TRUE,A2:A3,"",D7)')).toBe("Ann, Bob");
    expect(f('=TEXTJOIN("-",FALSE,"a","","b")')).toBe("a--b");
    expect(f('=LEFT("hello",2)')).toBe("he");
    expect(f('=LEFT("hello")')).toBe("h");
    expect(f('=RIGHT("hello",3)')).toBe("llo");
    expect(f('=MID("hello",2,3)')).toBe("ell");
    expect(f('=MID("hello",0,3)')).toEqual({ error: "#VALUE!" });
    expect(f('=LEN("hello")')).toBe(5);
    expect(f('=UPPER("Hi")')).toBe("HI");
    expect(f('=LOWER("Hi")')).toBe("hi");
    expect(f('=TRIM("  a   b ")')).toBe("a b");
    expect(f('=TEXT(0.125,"0.0%")')).toBe("12.5%");
    expect(f('=TEXT(D2,"mmm d")')).toBe("Jan 15");
    expect(f('=TEXT("5","0.00")')).toBe("5.00");
    expect(f('=VALUE("1,200")')).toBe(1200);
    expect(f('=VALUE("10%")')).toBe(0.1);
    expect(f('=VALUE("x")')).toEqual({ error: "#VALUE!" });
    expect(f("=1/3&\"\"")).toBe("0.3333333333");
  });
});

describe("dates", () => {
  it("builds and splits serial dates", () => {
    expect(f("=DATE(2026,3,15)")).toBe(46096);
    expect(f("=DATE(2026,14,1)")).toBe(f("=DATE(2027,2,1)"));
    expect(f("=DATE(26,1,1)")).toBe(f("=DATE(1926,1,1)"));
    expect(f("=YEAR(D2)")).toBe(2026);
    expect(f("=MONTH(D2)")).toBe(1);
    expect(f("=DAY(D2)")).toBe(15);
    expect(f('=DAY("2026-03-15")')).toBe(15);
    expect(f("=YEAR(-1)")).toEqual({ error: "#NUM!" });
    expect(f("=EOMONTH(D2,0)")).toBe(f("=DATE(2026,1,31)"));
    expect(f("=EOMONTH(D2,1)")).toBe(f("=DATE(2026,2,28)"));
    expect(f("=EOMONTH(D2,-1)")).toBe(f("=DATE(2025,12,31)"));
  });

  it("reads the injected clock for TODAY and NOW", () => {
    expect(f("=TODAY()")).toBe(46096);
    expect(f("=NOW()")).toBe(46096.5);
    const rome = fresh({ now: () => Date.UTC(2026, 2, 15, 23, 30), utcOffsetMinutes: 60 });
    expect(calc(rome, "=TODAY()")).toBe(46097);
  });
});
