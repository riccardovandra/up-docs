// Formula parser: tokens -> AST. Precedence, lowest first: comparison
// (= <> < > <= >=), &, + -, * /, ^, unary minus, percent. Like Sheets, unary
// minus binds tighter than ^ (-2^2 = 4) and ^ is left-associative.

import type { AreaRef } from "../address.ts";
import type { ErrorCode } from "../types.ts";
import { tokenize, type Token } from "./tokenizer.ts";

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type Node =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "error"; readonly code: ErrorCode }
  | { readonly kind: "ref"; readonly ref: AreaRef }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unary"; readonly op: "-" | "+"; readonly arg: Node }
  | { readonly kind: "percent"; readonly arg: Node }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Node; readonly right: Node }
  | { readonly kind: "call"; readonly name: string; readonly args: ReadonlyArray<Node> };

export class FormulaParseError extends Error {}

const BINARY_POWER: Readonly<Record<BinaryOp, number>> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
};
const UNARY_POWER = 6;

/** Parses formula text with or without the leading "=". Throws FormulaParseError. */
export function parseFormula(text: string): Node {
  const body = text.startsWith("=") ? text.slice(1) : text;
  const tokens = tokenize(body).filter((t) => t.type !== "space");
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const fail = (what: string): never => {
    throw new FormulaParseError(what);
  };

  function parseExpression(minPower: number): Node {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.type === "percent") {
        pos++;
        left = { kind: "percent", arg: left };
        continue;
      }
      if (t.type !== "op") break;
      const op = t.text as BinaryOp;
      const power = BINARY_POWER[op];
      if (power <= minPower) break;
      pos++;
      const right = parseExpression(power);
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  function parsePrefix(): Node {
    const t = peek();
    if (!t) return fail("Formula ends early");
    pos++;
    switch (t.type) {
      case "number": {
        const value = Number(t.text);
        return Number.isFinite(value) ? { kind: "number", value } : fail(`Bad number ${t.text}`);
      }
      case "string":
        return { kind: "string", value: t.text.slice(1, -1).replace(/""/g, '"') };
      case "bool":
        return { kind: "boolean", value: t.text.toUpperCase() === "TRUE" };
      case "error":
        return { kind: "error", code: t.text.toUpperCase() as ErrorCode };
      case "ref":
        return { kind: "ref", ref: t.ref as AreaRef };
      case "name":
        return { kind: "name", name: t.text };
      case "op":
        if (t.text === "-" || t.text === "+") {
          return { kind: "unary", op: t.text, arg: parseExpression(UNARY_POWER) };
        }
        return fail(`Unexpected ${t.text}`);
      case "lparen": {
        const inner = parseExpression(0);
        if (peek()?.type !== "rparen") fail("Missing )");
        pos++;
        return inner;
      }
      case "func":
        return parseCall(t.text);
      default:
        return fail(`Unexpected ${t.text}`);
    }
  }

  function parseCall(name: string): Node {
    if (peek()?.type !== "lparen") fail("Missing (");
    pos++;
    const args: Node[] = [];
    if (peek()?.type === "rparen") {
      pos++;
      return { kind: "call", name: name.toUpperCase(), args };
    }
    for (;;) {
      const t = peek();
      if (t?.type === "comma" || t?.type === "rparen") args.push({ kind: "missing" });
      else args.push(parseExpression(0));
      const sep = peek();
      if (sep?.type === "comma") {
        pos++;
        continue;
      }
      if (sep?.type === "rparen") {
        pos++;
        break;
      }
      fail("Missing ) after arguments");
    }
    return { kind: "call", name: name.toUpperCase(), args };
  }

  const node = parseExpression(0);
  if (pos < tokens.length) fail(`Unexpected ${tokens[pos]?.text}`);
  return node;
}
