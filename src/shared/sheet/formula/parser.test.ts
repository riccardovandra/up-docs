import { describe, expect, it } from "vitest";

import { FormulaParseError, parseFormula } from "./parser.ts";
import { tokenize } from "./tokenizer.ts";

describe("tokenize", () => {
  it("splits references, functions, literals and operators with spans", () => {
    const t = tokenize("SUM(Historical!C:C, $A$1)*10%&\"x\"\"y\"");
    expect(t.map((x) => x.type)).toEqual([
      "func",
      "lparen",
      "ref",
      "comma",
      "space",
      "ref",
      "rparen",
      "op",
      "number",
      "percent",
      "op",
      "string",
    ]);
    expect(t[2]?.text).toBe("Historical!C:C");
    expect(t.map((x) => x.text).join("")).toBe("SUM(Historical!C:C, $A$1)*10%&\"x\"\"y\"");
  });

  it("tells function names that look like cells apart", () => {
    expect(tokenize("LOG10(5)")[0]?.type).toBe("func");
    expect(tokenize("A1B")[0]?.type).toBe("name");
    expect(tokenize("TRUE")[0]?.type).toBe("bool");
    expect(tokenize("2:3")[0]?.type).toBe("ref");
    expect(tokenize("1.5")[0]?.type).toBe("number");
    expect(tokenize("'My tab'!A1")[0]?.ref?.sheet).toBe("My tab");
    expect(tokenize("#REF!+1")[0]?.type).toBe("error");
  });
});

describe("parseFormula", () => {
  it("respects precedence", () => {
    expect(parseFormula("=1+2*3")).toMatchObject({ kind: "binary", op: "+", right: { kind: "binary", op: "*" } });
    expect(parseFormula("=-2^2")).toMatchObject({ kind: "binary", op: "^", left: { kind: "unary" } });
    expect(parseFormula("=2^3^2")).toMatchObject({ kind: "binary", op: "^", left: { kind: "binary", op: "^" } });
    expect(parseFormula("=1&2=\"12\"")).toMatchObject({ kind: "binary", op: "=", left: { kind: "binary", op: "&" } });
    expect(parseFormula("=50%")).toMatchObject({ kind: "percent", arg: { kind: "number", value: 50 } });
  });

  it("parses calls, empty arguments and upper-cases names", () => {
    expect(parseFormula("=sum(A1:B2, 3)")).toMatchObject({ kind: "call", name: "SUM", args: [{ kind: "ref" }, { kind: "number" }] });
    expect(parseFormula("=TODAY()")).toMatchObject({ kind: "call", name: "TODAY", args: [] });
    expect(parseFormula("=IF(A1,,2)")).toMatchObject({ args: [{ kind: "ref" }, { kind: "missing" }, { kind: "number" }] });
  });

  it("throws on malformed formulas", () => {
    for (const bad of ["=1+", "=(1", "=SUM(1", "=1 2", "=*3", "={1,2}", "=\"open"]) {
      expect(() => parseFormula(bad)).toThrow(FormulaParseError);
    }
  });
});
