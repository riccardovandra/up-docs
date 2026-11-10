// Spreadsheet functions. Arguments arrive evaluated: references as RangeValue
// (even a single cell, so SUM(A1) ignores text like SUM(A1:A1)), literals as
// scalars, omitted arguments as null.

import { dateToSerial, serialToParts } from "../dates.ts";
import { parseNumberText } from "../input.ts";
import { display } from "../numberFormat.ts";
import type { ErrorValue, Scalar } from "../types.ts";
import { makeCriterion, wildcardRegex, type Criterion } from "./criteria.ts";
import type { EvalContext } from "./evaluate.ts";
import {
  RangeValue,
  compareScalars,
  err,
  isError,
  lookupEquals,
  num,
  toBoolean,
  toNumber,
  toScalar,
  toText,
  type Value,
} from "./values.ts";

type Fn = (args: ReadonlyArray<Value>, ctx: EvalContext) => Value;

interface Spec {
  readonly min: number;
  readonly max: number;
  readonly fn: Fn;
}

const MANY = Number.POSITIVE_INFINITY;

// ---- argument helpers ----

function scalar(v: Value | undefined): Scalar {
  return v === undefined ? null : toScalar(v);
}

function number(v: Value | undefined): number | ErrorValue {
  return toNumber(scalar(v));
}

function text(v: Value | undefined): string | ErrorValue {
  return toText(scalar(v));
}

function int(v: Value | undefined): number | ErrorValue {
  const n = number(v);
  return isError(n) ? n : Math.trunc(n);
}

/** Numbers for SUM-like functions: ranges give their numbers, direct arguments are coerced. */
function numbers(args: ReadonlyArray<Value>): number[] | ErrorValue {
  const out: number[] = [];
  for (const a of args) {
    if (a instanceof RangeValue) {
      let error: ErrorValue | null = null;
      a.forEachUsed((v) => {
        if (error) return;
        if (isError(v)) error = v;
        else if (typeof v === "number") out.push(v);
      });
      if (error) return error;
    } else {
      if (a === null) continue;
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Every value in order: ranges flattened over their used cells. */
function flatten(args: ReadonlyArray<Value>, fn: (v: Scalar, fromRange: boolean) => ErrorValue | void): ErrorValue | null {
  for (const a of args) {
    if (a instanceof RangeValue) {
      let error: ErrorValue | null = null;
      a.forEachUsed((v) => {
        if (!error) error = fn(v, true) ?? null;
      });
      if (error) return error;
    } else {
      const e = fn(a, false);
      if (e) return e;
    }
  }
  return null;
}

interface Grid {
  readonly rows: number;
  readonly cols: number;
  /** Rows/cols worth scanning; cells beyond are blank. */
  readonly usedRows: number;
  readonly usedCols: number;
  at(i: number, j: number): Scalar;
}

function grid(v: Value): Grid {
  if (v instanceof RangeValue) return v;
  return { rows: 1, cols: 1, usedRows: 1, usedCols: 1, at: () => v };
}

function roundWith(x: number, digits: number, mode: (n: number) => number): number {
  const f = 10 ** digits;
  const scaled = Number((Math.abs(x) * f).toPrecision(15));
  const r = mode(scaled) / f;
  return x < 0 ? -r : r;
}

function roundFn(mode: (n: number) => number): Fn {
  return ([x, d]) => {
    const n = number(x);
    if (isError(n)) return n;
    const digits = d === undefined ? 0 : int(d);
    if (isError(digits)) return digits;
    return num(roundWith(n, digits, mode));
  };
}

// ---- conditional aggregates ----

interface CondArgs {
  readonly ranges: ReadonlyArray<Grid>;
  readonly criteria: ReadonlyArray<Criterion>;
}

function condPairs(args: ReadonlyArray<Value>, from: number): CondArgs | ErrorValue {
  const ranges: Grid[] = [];
  const criteria: Criterion[] = [];
  for (let i = from; i < args.length; i += 2) {
    const crit = scalar(args[i + 1]);
    ranges.push(grid(args[i] as Value));
    criteria.push(makeCriterion(crit));
  }
  const first = ranges[0];
  if (!first) return err("#N/A");
  if (ranges.some((r) => r.rows !== first.rows || r.cols !== first.cols)) return err("#VALUE!");
  return { ranges, criteria };
}

/**
 * Visits each position where every criterion matches, scanning the used part;
 * returns how many blank-only positions beyond it also match (for COUNTIFS).
 */
function eachMatch(
  cond: CondArgs,
  target: Grid | null,
  visit: (i: number, j: number) => ErrorValue | void,
): number | ErrorValue {
  const all = target ? [...cond.ranges, target] : cond.ranges;
  const first = cond.ranges[0] as Grid;
  const rows = Math.min(first.rows, Math.max(...all.map((g) => g.usedRows)));
  const cols = Math.min(first.cols, Math.max(...all.map((g) => g.usedCols)));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let ok = true;
      for (let k = 0; k < cond.ranges.length && ok; k++) {
        ok = (cond.criteria[k] as Criterion)((cond.ranges[k] as Grid).at(i, j));
      }
      if (ok) {
        const e = visit(i, j);
        if (e) return e;
      }
    }
  }
  const tail = first.rows * first.cols - rows * cols;
  return tail > 0 && cond.criteria.every((c) => c(null)) ? tail : 0;
}

function sumWhere(cond: CondArgs, target: Grid): Scalar {
  let sum = 0;
  const r = eachMatch(cond, target, (i, j) => {
    const v = target.at(i, j);
    if (isError(v)) return v;
    if (typeof v === "number") sum += v;
  });
  return isError(r) ? r : num(sum);
}

function averageWhere(cond: CondArgs, target: Grid): Scalar {
  let sum = 0;
  let count = 0;
  const r = eachMatch(cond, target, (i, j) => {
    const v = target.at(i, j);
    if (isError(v)) return v;
    if (typeof v === "number") {
      sum += v;
      count++;
    }
  });
  if (isError(r)) return r;
  return count === 0 ? err("#DIV/0!") : num(sum / count);
}

function countWhere(cond: CondArgs): Scalar {
  let count = 0;
  const tail = eachMatch(cond, null, () => {
    count++;
  });
  return isError(tail) ? tail : count + tail;
}

/** SUMIF/AVERAGEIF target: same shape as the criteria range, from the target's top-left. */
function resizeTo(target: Value, shape: Grid): Grid {
  if (!(target instanceof RangeValue)) return grid(target);
  return new RangeValue(
    target.source,
    target.sheetId,
    target.r1,
    target.c1,
    target.r1 + shape.rows - 1,
    target.c1 + shape.cols - 1,
  );
}

// ---- lookups ----

/** A 1-D view along rows (vertical) or columns. */
function vector(g: Grid, vertical: boolean, fixed: number): { length: number; used: number; at(i: number): Scalar } {
  return vertical
    ? { length: g.rows, used: g.usedRows, at: (i) => g.at(i, fixed) }
    : { length: g.cols, used: g.usedCols, at: (i) => g.at(fixed, i) };
}

function sameType(a: Scalar, b: Scalar): boolean {
  return a !== null && b !== null && !isError(a) && !isError(b) && typeof a === typeof b;
}

/** Position of the last value <= key (ascending data), stopping at the first greater value. */
function approxAscending(vec: { used: number; at(i: number): Scalar }, key: Scalar): number {
  let best = -1;
  for (let i = 0; i < vec.used; i++) {
    const v = vec.at(i);
    if (!sameType(v, key)) continue;
    if (compareScalars(v as never, key as never) <= 0) best = i;
    else break;
  }
  return best;
}

function exactIndex(vec: { used: number; at(i: number): Scalar }, key: Scalar, wildcards: boolean): number {
  const re = wildcards && typeof key === "string" && /[*?~]/.test(key) ? wildcardRegex(key) : null;
  for (let i = 0; i < vec.used; i++) {
    const v = vec.at(i);
    if (re ? typeof v === "string" && re.test(v) : lookupEquals(v, key)) return i;
  }
  return -1;
}

function lookup(vertical: boolean): Fn {
  return ([keyArg, rangeArg, indexArg, sortedArg]) => {
    const key = scalar(keyArg);
    if (isError(key)) return key;
    const g = grid(rangeArg as Value);
    const index = int(indexArg);
    if (isError(index)) return index;
    if (index < 1) return err("#VALUE!");
    if (index > (vertical ? g.cols : g.rows)) return err("#REF!");
    const sorted = sortedArg === undefined || sortedArg === null ? true : toBoolean(scalar(sortedArg));
    if (isError(sorted)) return sorted;
    const vec = vector(g, vertical, 0);
    const pos = sorted ? approxAscending(vec, key) : exactIndex(vec, key, true);
    if (pos < 0) return err("#N/A");
    return vertical ? g.at(pos, index - 1) : g.at(index - 1, pos);
  };
}

function oneDimension(g: Grid): { length: number; used: number; at(i: number): Scalar; vertical: boolean } | null {
  if (g.cols === 1) return { ...vector(g, true, 0), vertical: true };
  if (g.rows === 1) return { ...vector(g, false, 0), vertical: false };
  return null;
}

const match: Fn = ([keyArg, rangeArg, typeArg]) => {
  const key = scalar(keyArg);
  if (isError(key)) return key;
  const vec = oneDimension(grid(rangeArg as Value));
  if (!vec) return err("#N/A");
  const type = typeArg === undefined || typeArg === null ? 1 : int(typeArg);
  if (isError(type)) return type;
  let pos: number;
  if (type === 0) pos = exactIndex(vec, key, true);
  else if (type > 0) pos = approxAscending(vec, key);
  else {
    pos = -1;
    for (let i = 0; i < vec.used; i++) {
      const v = vec.at(i);
      if (!sameType(v, key)) continue;
      if (compareScalars(v as never, key as never) >= 0) pos = i;
      else break;
    }
  }
  return pos < 0 ? err("#N/A") : pos + 1;
};

const xlookup: Fn = ([keyArg, lookupArg, resultArg, missingArg, modeArg, searchArg]) => {
  const key = scalar(keyArg);
  if (isError(key)) return key;
  const vec = oneDimension(grid(lookupArg as Value));
  if (!vec) return err("#VALUE!");
  const result = resultArg as Value;
  const rg = grid(result);
  if ((vec.vertical ? rg.rows : rg.cols) !== vec.length) return err("#VALUE!");
  const mode = modeArg === undefined || modeArg === null ? 0 : int(modeArg);
  if (isError(mode)) return mode;
  const search = searchArg === undefined || searchArg === null ? 1 : int(searchArg);
  if (isError(search)) return search;
  const order: number[] = [];
  for (let i = 0; i < vec.used; i++) order.push(i);
  if (search < 0) order.reverse();
  const re = mode === 2 && typeof key === "string" ? wildcardRegex(key) : null;
  let pos = -1;
  let best: Scalar = null;
  for (const i of order) {
    const v = vec.at(i);
    if (re ? typeof v === "string" && re.test(v) : lookupEquals(v, key)) {
      pos = i;
      break;
    }
    if ((mode === -1 || mode === 1) && sameType(v, key)) {
      const c = compareScalars(v as never, key as never);
      const better =
        best === null || (mode === -1 ? compareScalars(v as never, best as never) > 0 : compareScalars(v as never, best as never) < 0);
      if ((mode === -1 ? c < 0 : c > 0) && better) {
        best = v;
        pos = i;
      }
    }
  }
  if (pos < 0) return missingArg === undefined || missingArg === null ? err("#N/A") : missingArg;
  if (!(result instanceof RangeValue)) return result;
  return vec.vertical
    ? new RangeValue(result.source, result.sheetId, result.r1 + pos, result.c1, result.r1 + pos, result.c2)
    : new RangeValue(result.source, result.sheetId, result.r1, result.c1 + pos, result.r2, result.c1 + pos);
};

const index: Fn = ([rangeArg, rowArg, colArg]) => {
  const range = rangeArg as Value;
  const g = grid(range);
  let row = rowArg === undefined || rowArg === null ? 0 : int(rowArg);
  if (isError(row)) return row;
  let col = colArg === undefined || colArg === null ? 0 : int(colArg);
  if (isError(col)) return col;
  if (colArg === undefined && g.rows === 1 && g.cols > 1) {
    col = row;
    row = 1;
  }
  if (row < 0 || col < 0 || row > g.rows || col > g.cols) return err("#REF!");
  if (row === 0 && col === 0 && g.rows * g.cols > 1) return range;
  if (row === 0 && g.cols === 1) row = g.rows === 1 ? 1 : 0;
  if (col === 0 && g.cols === 1) col = 1;
  if (row > 0 && col > 0) return g.at(row - 1, col - 1);
  if (!(range instanceof RangeValue)) return err("#REF!");
  return row === 0
    ? new RangeValue(range.source, range.sheetId, range.r1, range.c1 + col - 1, range.r2, range.c1 + col - 1)
    : new RangeValue(range.source, range.sheetId, range.r1 + row - 1, range.c1, range.r1 + row - 1, range.c2);
};

// ---- text ----

function textFn(f: (s: string) => Scalar): Fn {
  return ([a]) => {
    const s = text(a);
    return isError(s) ? s : f(s);
  };
}

function concat(args: ReadonlyArray<Value>): Scalar {
  let out = "";
  const e = flatten(args, (v) => {
    const t = toText(v);
    if (isError(t)) return t;
    out += t;
  });
  return e ?? out;
}

const textjoin: Fn = ([delimArg, ignoreArg, ...rest]) => {
  const delim = text(delimArg);
  if (isError(delim)) return delim;
  const ignore = toBoolean(scalar(ignoreArg));
  if (isError(ignore)) return ignore;
  const parts: string[] = [];
  for (const a of rest) {
    if (a instanceof RangeValue) {
      // Every cell, not only used ones: empty cells add delimiters unless ignored.
      for (let i = 0; i < (ignore ? a.usedRows : a.rows); i++) {
        for (let j = 0; j < (ignore ? a.usedCols : a.cols); j++) {
          const t = toText(a.at(i, j));
          if (isError(t)) return t;
          if (!(ignore && t === "")) parts.push(t);
        }
      }
    } else {
      const t = toText(a);
      if (isError(t)) return t;
      if (!(ignore && t === "")) parts.push(t);
    }
  }
  return parts.join(delim);
};

// ---- dates ----

function dateParts(v: Value | undefined): ReturnType<typeof serialToParts> | ErrorValue {
  const n = number(v);
  if (isError(n)) return n;
  if (n < 0) return err("#NUM!");
  return serialToParts(n);
}

// ---- registry ----

const FUNCTIONS: Readonly<Record<string, Spec>> = {
  SUM: {
    min: 1,
    max: MANY,
    fn: (args) => {
      const ns = numbers(args);
      return isError(ns) ? ns : num(ns.reduce((s, n) => s + n, 0));
    },
  },
  AVERAGE: {
    min: 1,
    max: MANY,
    fn: (args) => {
      const ns = numbers(args);
      if (isError(ns)) return ns;
      return ns.length === 0 ? err("#DIV/0!") : num(ns.reduce((s, n) => s + n, 0) / ns.length);
    },
  },
  MIN: {
    min: 1,
    max: MANY,
    fn: (args) => {
      const ns = numbers(args);
      return isError(ns) ? ns : ns.length === 0 ? 0 : ns.reduce((m, n) => (n < m ? n : m));
    },
  },
  MAX: {
    min: 1,
    max: MANY,
    fn: (args) => {
      const ns = numbers(args);
      return isError(ns) ? ns : ns.length === 0 ? 0 : ns.reduce((m, n) => (n > m ? n : m));
    },
  },
  MEDIAN: {
    min: 1,
    max: MANY,
    fn: (args) => {
      const ns = numbers(args);
      if (isError(ns)) return ns;
      if (ns.length === 0) return err("#NUM!");
      const s = [...ns].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
    },
  },
  PRODUCT: {
    min: 1,
    max: MANY,
    fn: (args) => {
      const ns = numbers(args);
      return isError(ns) ? ns : ns.length === 0 ? 0 : num(ns.reduce((p, n) => p * n, 1));
    },
  },
  COUNT: {
    min: 1,
    max: MANY,
    fn: (args) => {
      let count = 0;
      flatten(args, (v, fromRange) => {
        if (typeof v === "number") count++;
        else if (!fromRange && (typeof v === "boolean" || (typeof v === "string" && parseNumberText(v)))) count++;
      });
      return count;
    },
  },
  COUNTA: {
    min: 1,
    max: MANY,
    fn: (args) => {
      let count = 0;
      flatten(args, (v) => {
        if (v !== null) count++;
      });
      return count;
    },
  },
  COUNTBLANK: {
    min: 1,
    max: 1,
    fn: ([a]) => {
      const g = grid(a as Value);
      let filled = 0;
      for (let i = 0; i < g.usedRows; i++) {
        for (let j = 0; j < g.usedCols; j++) {
          const v = g.at(i, j);
          if (v !== null && v !== "") filled++;
        }
      }
      return g.rows * g.cols - filled;
    },
  },
  ROUND: { min: 1, max: 2, fn: roundFn(Math.round) },
  ROUNDUP: { min: 1, max: 2, fn: roundFn(Math.ceil) },
  ROUNDDOWN: { min: 1, max: 2, fn: roundFn(Math.floor) },
  ABS: {
    min: 1,
    max: 1,
    fn: ([a]) => {
      const n = number(a);
      return isError(n) ? n : Math.abs(n);
    },
  },
  IF: {
    min: 2,
    max: 3,
    fn: ([c, a, b]) => {
      const cond = toBoolean(scalar(c));
      if (isError(cond)) return cond;
      return cond ? (a ?? null) : b === undefined ? false : b;
    },
  },
  IFS: {
    min: 2,
    max: MANY,
    fn: (args) => {
      if (args.length % 2) return err("#N/A");
      for (let i = 0; i < args.length; i += 2) {
        const cond = toBoolean(scalar(args[i]));
        if (isError(cond)) return cond;
        if (cond) return args[i + 1] as Value;
      }
      return err("#N/A");
    },
  },
  IFERROR: {
    min: 1,
    max: 2,
    fn: ([v, alt]) => {
      const s = scalar(v);
      return isError(s) ? (alt === undefined ? "" : alt) : (v as Value);
    },
  },
  IFNA: {
    min: 2,
    max: 2,
    fn: ([v, alt]) => {
      const s = scalar(v);
      return isError(s) && s.error === "#N/A" ? (alt as Value) : (v as Value);
    },
  },
  AND: { min: 1, max: MANY, fn: (args) => logical(args, (acc, b) => acc && b, true) },
  OR: { min: 1, max: MANY, fn: (args) => logical(args, (acc, b) => acc || b, false) },
  NOT: {
    min: 1,
    max: 1,
    fn: ([a]) => {
      const b = toBoolean(scalar(a));
      return isError(b) ? b : !b;
    },
  },
  TRUE: { min: 0, max: 0, fn: () => true },
  FALSE: { min: 0, max: 0, fn: () => false },
  SUMIF: {
    min: 2,
    max: 3,
    fn: ([range, crit, target]) => {
      const cond = condPairs([range as Value, crit as Value], 0);
      if (isError(cond)) return cond;
      const shape = cond.ranges[0] as Grid;
      return sumWhere(cond, target === undefined ? shape : resizeTo(target, shape));
    },
  },
  SUMIFS: {
    min: 3,
    max: MANY,
    fn: (args) => {
      if (args.length % 2 === 0) return err("#N/A");
      const cond = condPairs(args, 1);
      if (isError(cond)) return cond;
      const target = grid(args[0] as Value);
      const shape = cond.ranges[0] as Grid;
      if (target.rows !== shape.rows || target.cols !== shape.cols) return err("#VALUE!");
      return sumWhere(cond, target);
    },
  },
  COUNTIF: {
    min: 2,
    max: 2,
    fn: (args) => {
      const cond = condPairs(args, 0);
      return isError(cond) ? cond : countWhere(cond);
    },
  },
  COUNTIFS: {
    min: 2,
    max: MANY,
    fn: (args) => {
      if (args.length % 2) return err("#N/A");
      const cond = condPairs(args, 0);
      return isError(cond) ? cond : countWhere(cond);
    },
  },
  AVERAGEIF: {
    min: 2,
    max: 3,
    fn: ([range, crit, target]) => {
      const cond = condPairs([range as Value, crit as Value], 0);
      if (isError(cond)) return cond;
      const shape = cond.ranges[0] as Grid;
      return averageWhere(cond, target === undefined ? shape : resizeTo(target, shape));
    },
  },
  AVERAGEIFS: {
    min: 3,
    max: MANY,
    fn: (args) => {
      if (args.length % 2 === 0) return err("#N/A");
      const cond = condPairs(args, 1);
      if (isError(cond)) return cond;
      const target = grid(args[0] as Value);
      const shape = cond.ranges[0] as Grid;
      if (target.rows !== shape.rows || target.cols !== shape.cols) return err("#VALUE!");
      return averageWhere(cond, target);
    },
  },
  VLOOKUP: { min: 3, max: 4, fn: lookup(true) },
  HLOOKUP: { min: 3, max: 4, fn: lookup(false) },
  XLOOKUP: { min: 3, max: 6, fn: xlookup },
  INDEX: { min: 1, max: 3, fn: index },
  MATCH: { min: 2, max: 3, fn: match },
  CONCAT: { min: 1, max: MANY, fn: concat },
  CONCATENATE: { min: 1, max: MANY, fn: concat },
  TEXTJOIN: { min: 3, max: MANY, fn: textjoin },
  LEFT: {
    min: 1,
    max: 2,
    fn: ([a, n]) => {
      const s = text(a);
      if (isError(s)) return s;
      const k = n === undefined ? 1 : int(n);
      if (isError(k)) return k;
      return k < 0 ? err("#VALUE!") : s.slice(0, k);
    },
  },
  RIGHT: {
    min: 1,
    max: 2,
    fn: ([a, n]) => {
      const s = text(a);
      if (isError(s)) return s;
      const k = n === undefined ? 1 : int(n);
      if (isError(k)) return k;
      return k < 0 ? err("#VALUE!") : k === 0 ? "" : s.slice(-k);
    },
  },
  MID: {
    min: 3,
    max: 3,
    fn: ([a, start, n]) => {
      const s = text(a);
      if (isError(s)) return s;
      const st = int(start);
      if (isError(st)) return st;
      const k = int(n);
      if (isError(k)) return k;
      if (st < 1 || k < 0) return err("#VALUE!");
      return s.slice(st - 1, st - 1 + k);
    },
  },
  LEN: { min: 1, max: 1, fn: textFn((s) => s.length) },
  UPPER: { min: 1, max: 1, fn: textFn((s) => s.toUpperCase()) },
  LOWER: { min: 1, max: 1, fn: textFn((s) => s.toLowerCase()) },
  TRIM: { min: 1, max: 1, fn: textFn((s) => s.replace(/ +/g, " ").trim()) },
  TEXT: {
    min: 2,
    max: 2,
    fn: ([a, p]) => {
      const v = scalar(a);
      if (isError(v)) return v;
      const pattern = text(p);
      if (isError(pattern)) return pattern;
      const value = typeof v === "string" ? (parseNumberText(v)?.value ?? v) : v;
      return display(value, pattern);
    },
  },
  VALUE: {
    min: 1,
    max: 1,
    fn: ([a]) => {
      const v = scalar(a);
      if (isError(v) || typeof v === "number") return v;
      if (v === null) return 0;
      if (typeof v === "boolean") return err("#VALUE!");
      const n = parseNumberText(v);
      return n ? n.value : err("#VALUE!");
    },
  },
  TODAY: { min: 0, max: 0, fn: (_args, ctx) => Math.floor(ctx.nowSerial()) },
  NOW: { min: 0, max: 0, fn: (_args, ctx) => ctx.nowSerial() },
  DATE: {
    min: 3,
    max: 3,
    fn: ([y, m, d]) => {
      let year = int(y);
      if (isError(year)) return year;
      const month = int(m);
      if (isError(month)) return month;
      const day = int(d);
      if (isError(day)) return day;
      if (year >= 0 && year < 1900) year += 1900;
      if (year < 0 || year > 9999) return err("#NUM!");
      const serial = dateToSerial(year, month, day);
      return serial < 0 ? err("#NUM!") : serial;
    },
  },
  YEAR: {
    min: 1,
    max: 1,
    fn: ([a]) => {
      const p = dateParts(a);
      return isError(p) ? p : p.year;
    },
  },
  MONTH: {
    min: 1,
    max: 1,
    fn: ([a]) => {
      const p = dateParts(a);
      return isError(p) ? p : p.month;
    },
  },
  DAY: {
    min: 1,
    max: 1,
    fn: ([a]) => {
      const p = dateParts(a);
      return isError(p) ? p : p.day;
    },
  },
  EOMONTH: {
    min: 2,
    max: 2,
    fn: ([start, months]) => {
      const p = dateParts(start);
      if (isError(p)) return p;
      const k = int(months);
      if (isError(k)) return k;
      const serial = dateToSerial(p.year, p.month + k + 1, 0);
      return serial < 0 ? err("#NUM!") : serial;
    },
  },
};

function logical(args: ReadonlyArray<Value>, combine: (acc: boolean, b: boolean) => boolean, start: boolean): Scalar {
  let acc = start;
  let seen = false;
  const e = flatten(args, (v, fromRange) => {
    if (isError(v)) return v;
    if (fromRange) {
      if (typeof v === "boolean" || typeof v === "number") {
        acc = combine(acc, toBoolean(v) as boolean);
        seen = true;
      }
      return;
    }
    if (v === null) return;
    const b = toBoolean(v);
    if (isError(b)) return b;
    acc = combine(acc, b);
    seen = true;
  });
  if (e) return e;
  return seen ? acc : err("#VALUE!");
}

export function isKnownFunction(name: string): boolean {
  return Object.hasOwn(FUNCTIONS, name);
}

/** Names of every supported function. */
export const FUNCTION_NAMES: ReadonlyArray<string> = Object.keys(FUNCTIONS).sort();

/** Argument positions that must be ranges; an error there (e.g. a deleted sheet's #REF!) is the result. */
function rangeArgs(name: string, count: number): number[] {
  const every = (from: number) => Array.from({ length: count }, (_, i) => i).filter((i) => i >= from && (i - from) % 2 === 0);
  switch (name) {
    case "SUMIF":
    case "AVERAGEIF":
      return [0, 2];
    case "SUMIFS":
    case "AVERAGEIFS":
      return [0, ...every(1)];
    case "COUNTIF":
    case "COUNTIFS":
      return every(0);
    case "VLOOKUP":
    case "HLOOKUP":
    case "MATCH":
      return [1];
    case "XLOOKUP":
      return [1, 2];
    case "INDEX":
    case "COUNTBLANK":
      return [0];
    default:
      return [];
  }
}

export function callFunction(name: string, args: ReadonlyArray<Value>, ctx: EvalContext): Value {
  const spec = FUNCTIONS[name];
  if (!spec) return err("#NAME?");
  if (args.length < spec.min || args.length > spec.max) return err("#N/A");
  for (const i of rangeArgs(name, args.length)) {
    const a = args[i];
    if (isError(a)) return a;
  }
  return spec.fn(args, ctx);
}
