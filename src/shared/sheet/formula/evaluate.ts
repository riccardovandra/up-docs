// Evaluates a formula AST against cell values. Evaluation never reads another
// formula's AST: recalc orders cells so every precedent already has its value.

import type { AreaRef } from "../address.ts";
import type { Scalar, SheetId } from "../types.ts";
import { callFunction, isKnownFunction } from "./functions.ts";
import type { Node } from "./parser.ts";
import {
  RangeValue,
  compareScalars,
  err,
  isError,
  num,
  toNumber,
  toScalar,
  toText,
  type CellSource,
  type Value,
} from "./values.ts";

export interface EvalContext extends CellSource {
  /** The sheet that holds the formula. */
  readonly sheetId: SheetId;
  sheetIdByName(name: string): SheetId | null;
  sheetSize(sheetId: SheetId): { readonly rowCount: number; readonly columnCount: number };
  /** Current date-time as a serial number. */
  nowSerial(): number;
  /** Effective number format of a cell (explicit or implied), for format inference. */
  patternAt(sheetId: SheetId, row: number, col: number): string | null;
}

export function resolveRef(ref: AreaRef, ctx: EvalContext): RangeValue | null {
  const sheetId = ref.sheet === null ? ctx.sheetId : ctx.sheetIdByName(ref.sheet);
  if (sheetId === null) return null;
  const size = ctx.sheetSize(sheetId);
  const r1 = ref.startRow ?? 0;
  const c1 = ref.startCol ?? 0;
  const r2 = Math.max(r1, ref.endRow ?? size.rowCount - 1);
  const c2 = Math.max(c1, ref.endCol ?? size.columnCount - 1);
  return new RangeValue(ctx, sheetId, r1, c1, r2, c2);
}

export function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.kind) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "boolean":
      return node.value;
    case "error":
      return err(node.code);
    case "missing":
      return null;
    case "name":
      return err("#NAME?");
    case "ref":
      return resolveRef(node.ref, ctx) ?? err("#REF!");
    case "percent": {
      const n = toNumber(toScalar(evaluate(node.arg, ctx)));
      return isError(n) ? n : n / 100;
    }
    case "unary": {
      const n = toNumber(toScalar(evaluate(node.arg, ctx)));
      if (isError(n)) return n;
      return node.op === "-" ? num(-n) : n;
    }
    case "binary":
      return binary(node.op, toScalar(evaluate(node.left, ctx)), toScalar(evaluate(node.right, ctx)));
    case "call": {
      if (!isKnownFunction(node.name)) return err("#NAME?");
      const args = node.args.map((a) => evaluate(a, ctx));
      return callFunction(node.name, args, ctx);
    }
  }
}

function binary(op: string, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === "&") {
    return `${toText(a) as string}${toText(b) as string}`;
  }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    const c = compareScalars(a, b);
    switch (op) {
      case "=":
        return c === 0;
      case "<>":
        return c !== 0;
      case "<":
        return c < 0;
      case ">":
        return c > 0;
      case "<=":
        return c <= 0;
      default:
        return c >= 0;
    }
  }
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  switch (op) {
    case "+":
      return num(x + y);
    case "-":
      return num(x - y);
    case "*":
      return num(x * y);
    case "/":
      return y === 0 ? err("#DIV/0!") : num(x / y);
    case "^":
      if (x === 0 && y < 0) return err("#DIV/0!");
      return num(x ** y);
    default:
      return err("#ERROR!");
  }
}

/** Evaluates a cell's formula to the value the cell holds. */
export function evaluateCell(node: Node, ctx: EvalContext): Scalar {
  return toScalar(evaluate(node, ctx));
}

const DATE_FUNCTIONS = new Set(["DATE", "TODAY", "EOMONTH"]);
const INHERIT_FIRST_ARG = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "MEDIAN",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "ABS",
  "IF",
  "IFERROR",
  "IFNA",
]);

/**
 * Number format a formula result inherits when its cell has none: dates from
 * DATE/TODAY/EOMONTH, date-time from NOW, otherwise the format of the first
 * referenced cell for references, + and -, and aggregates such as SUM.
 */
export function impliedPattern(node: Node, ctx: EvalContext): string | null {
  switch (node.kind) {
    case "ref": {
      const sheetId = node.ref.sheet === null ? ctx.sheetId : ctx.sheetIdByName(node.ref.sheet);
      if (sheetId === null) return null;
      return ctx.patternAt(sheetId, node.ref.startRow ?? 0, node.ref.startCol ?? 0);
    }
    case "unary":
      return impliedPattern(node.arg, ctx);
    case "binary":
      if (node.op === "+" || node.op === "-") {
        return impliedPattern(node.left, ctx) ?? impliedPattern(node.right, ctx);
      }
      return null;
    case "call": {
      if (DATE_FUNCTIONS.has(node.name)) return "yyyy-mm-dd";
      if (node.name === "NOW") return "yyyy-mm-dd h:mm:ss";
      const first = node.name === "IF" ? node.args[1] : node.args[0];
      if (INHERIT_FIRST_ARG.has(node.name) && first) return impliedPattern(first, ctx);
      if ((node.name === "SUMIF" || node.name === "AVERAGEIF") && node.args[2]) {
        return impliedPattern(node.args[2], ctx);
      }
      if ((node.name === "SUMIFS" || node.name === "AVERAGEIFS") && node.args[0]) {
        return impliedPattern(node.args[0], ctx);
      }
      return null;
    }
    default:
      return null;
  }
}

/** References a formula reads, for the dependency graph. */
export function collectRefs(node: Node, out: AreaRef[] = []): AreaRef[] {
  switch (node.kind) {
    case "ref":
      out.push(node.ref);
      break;
    case "unary":
    case "percent":
      collectRefs(node.arg, out);
      break;
    case "binary":
      collectRefs(node.left, out);
      collectRefs(node.right, out);
      break;
    case "call":
      for (const a of node.args) collectRefs(a, out);
      break;
  }
  return out;
}

/** Whether the formula calls TODAY or NOW and must recompute on every change. */
export function isVolatile(node: Node): boolean {
  switch (node.kind) {
    case "call":
      return node.name === "TODAY" || node.name === "NOW" || node.args.some(isVolatile);
    case "unary":
    case "percent":
      return isVolatile(node.arg);
    case "binary":
      return isVolatile(node.left) || isVolatile(node.right);
    default:
      return false;
  }
}
