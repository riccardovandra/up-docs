// Formula tokenizer. Works on the text after "="; every token keeps its source
// span so reference rewriting can splice new text in and keep the rest as typed.

import { REF_PATTERN, refFromMatch, type AreaRef } from "../address.ts";
import type { ErrorCode } from "../types.ts";

export type TokenType =
  | "number"
  | "string"
  | "bool"
  | "error"
  | "ref"
  | "func"
  | "name"
  | "op"
  | "percent"
  | "lparen"
  | "rparen"
  | "comma"
  | "space"
  | "unknown";

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly ref?: AreaRef;
}

export const ERROR_LITERALS: ReadonlyArray<ErrorCode> = [
  "#REF!",
  "#DIV/0!",
  "#NAME?",
  "#VALUE!",
  "#N/A",
  "#NUM!",
  "#CYCLE!",
  "#ERROR!",
];

const NUMBER = /\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\./y;
const NAME = /[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/y;
const IDENT_CHAR = /[A-Za-z0-9_.$À-￿]/;
const OPERATORS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">"];

function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/** Reference starting at `at`, or null. Rejects function names (LOG10() and longer identifiers. */
function readRef(body: string, at: number): Token | null {
  const m = matchAt(REF_PATTERN, body, at);
  if (!m || m[0].length === 0) return null;
  const end = at + m[0].length;
  const next = body[end];
  if (next !== undefined && (IDENT_CHAR.test(next) || next === "(" || next === "!")) return null;
  const ref = refFromMatch(m);
  if (!ref) return null;
  return { type: "ref", text: m[0], start: at, end, ref };
}

export function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    const start = i;
    if (/\s/.test(ch)) {
      while (i < body.length && /\s/.test(body[i] as string)) i++;
      tokens.push({ type: "space", text: body.slice(start, i), start, end: i });
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < body.length) {
        if (body[i] === '"') {
          if (body[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      const closed = i < body.length;
      if (closed) i++;
      tokens.push({ type: closed ? "string" : "unknown", text: body.slice(start, i), start, end: i });
      continue;
    }
    if (ch === "#") {
      const upper = body.slice(i).toUpperCase();
      const lit = ERROR_LITERALS.find((e) => upper.startsWith(e));
      if (lit) {
        i += lit.length;
        tokens.push({ type: "error", text: body.slice(start, i), start, end: i });
      } else {
        i++;
        tokens.push({ type: "unknown", text: ch, start, end: i });
      }
      continue;
    }
    if (ch === "'" || ch === "$" || /[A-Za-z0-9_À-￿]/.test(ch)) {
      const ref = readRef(body, i);
      if (ref) {
        tokens.push(ref);
        i = ref.end;
        continue;
      }
    }
    if (/[0-9.]/.test(ch)) {
      const m = matchAt(NUMBER, body, i);
      if (m && m[0].length > 0) {
        i += m[0].length;
        tokens.push({ type: "number", text: m[0], start, end: i });
        continue;
      }
    }
    if (/[A-Za-z_À-￿]/.test(ch)) {
      const m = matchAt(NAME, body, i) as RegExpExecArray;
      i += m[0].length;
      let j = i;
      while (j < body.length && /\s/.test(body[j] as string)) j++;
      const text = m[0];
      if (body[j] === "(") tokens.push({ type: "func", text, start, end: i });
      else if (/^(TRUE|FALSE)$/i.test(text)) tokens.push({ type: "bool", text, start, end: i });
      else tokens.push({ type: "name", text, start, end: i });
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", text: ch, start, end: ++i });
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", text: ch, start, end: ++i });
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", text: ch, start, end: ++i });
      continue;
    }
    if (ch === "%") {
      tokens.push({ type: "percent", text: ch, start, end: ++i });
      continue;
    }
    const op = OPERATORS.find((o) => body.startsWith(o, i));
    if (op) {
      i += op.length;
      tokens.push({ type: "op", text: op, start, end: i });
      continue;
    }
    i++;
    tokens.push({ type: "unknown", text: ch, start, end: i });
  }
  return tokens;
}
