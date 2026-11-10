// Dependency graph and recalculation. `computeAll` evaluates a whole workbook;
// `recalcChanged` re-evaluates only the formulas that depend on changed cells
// (plus TODAY/NOW). Cells are evaluated in dependency order (Tarjan's strongly
// connected components), so a formula only ever reads finished values; every
// cell on a cycle gets #CYCLE!. Calc maps are copy-on-write: a previous
// workbook's values are never mutated.

import { areaContains, type Area, type AreaRef } from "./address.ts";
import { msToSerial } from "./dates.ts";
import {
  collectRefs,
  evaluateCell,
  impliedPattern,
  isVolatile,
  type EvalContext,
} from "./formula/evaluate.ts";
import { FormulaParseError, parseFormula, type Node } from "./formula/parser.ts";
import { err, isError } from "./formula/values.ts";
import { parseInput } from "./input.ts";
import {
  cellKey,
  keyCol,
  keyRow,
  type Calc,
  type Computed,
  type EngineOptions,
  type Scalar,
  type Sheet,
  type SheetId,
} from "./types.ts";

export interface CompiledFormula {
  /** null when the text does not parse (the cell shows #ERROR!). */
  readonly ast: Node | null;
  readonly refs: ReadonlyArray<AreaRef>;
  readonly volatile: boolean;
}

const compileCache = new Map<string, CompiledFormula>();

/** Parses formula text once; results are cached by text. */
export function compileFormula(formula: string): CompiledFormula {
  let c = compileCache.get(formula);
  if (c) return c;
  try {
    const ast = parseFormula(formula);
    c = { ast, refs: collectRefs(ast), volatile: isVolatile(ast) };
  } catch (e) {
    if (!(e instanceof FormulaParseError)) throw e;
    c = { ast: null, refs: [], volatile: false };
  }
  if (compileCache.size > 20_000) compileCache.clear();
  compileCache.set(formula, c);
  return c;
}

export function resolveOptions(options: EngineOptions = {}): Required<EngineOptions> {
  return { now: options.now ?? Date.now, utcOffsetMinutes: options.utcOffsetMinutes ?? 0 };
}

/** Computed value of a non-formula input, or null for blank. */
export function literalComputed(input: string): Computed | null {
  const p = parseInput(input);
  switch (p.kind) {
    case "blank":
    case "formula":
      return null;
    case "number":
    case "boolean":
    case "text":
      return { value: p.value, pattern: null };
  }
}

interface FormulaNode {
  readonly sheetId: SheetId;
  readonly key: number;
  readonly compiled: CompiledFormula;
}

type InnerValues = Map<number, Computed>;
type InnerFormulas = Map<number, CompiledFormula>;

class Work {
  readonly byId = new Map<SheetId, Sheet>();
  readonly byName = new Map<string, SheetId>();
  readonly values = new Map<SheetId, InnerValues>();
  readonly formulas = new Map<SheetId, InnerFormulas>();
  private readonly ownValues = new Set<SheetId>();
  private readonly ownFormulas = new Set<SheetId>();
  private readonly extents = new Map<SheetId, { rows: number; cols: number }>();
  private readonly contexts = new Map<SheetId, EvalContext>();
  readonly nowSerial: number;
  readonly sheets: ReadonlyArray<Sheet>;
  readonly options: Required<EngineOptions>;

  constructor(sheets: ReadonlyArray<Sheet>, options: Required<EngineOptions>, prev: Calc | null) {
    this.sheets = sheets;
    this.options = options;
    for (const s of sheets) {
      this.byId.set(s.id, s);
      this.byName.set(s.name.toLowerCase(), s.id);
      const v = prev?.values.get(s.id) as InnerValues | undefined;
      const f = prev?.formulas.get(s.id) as InnerFormulas | undefined;
      if (v) this.values.set(s.id, v);
      else {
        this.values.set(s.id, new Map());
        this.ownValues.add(s.id);
      }
      if (f) this.formulas.set(s.id, f);
      else {
        this.formulas.set(s.id, new Map());
        this.ownFormulas.add(s.id);
      }
    }
    this.nowSerial = msToSerial(options.now(), options.utcOffsetMinutes);
  }

  writableValues(id: SheetId): InnerValues {
    if (!this.ownValues.has(id)) {
      this.values.set(id, new Map(this.values.get(id)));
      this.ownValues.add(id);
    }
    return this.values.get(id) as InnerValues;
  }

  writableFormulas(id: SheetId): InnerFormulas {
    if (!this.ownFormulas.has(id)) {
      this.formulas.set(id, new Map(this.formulas.get(id)));
      this.ownFormulas.add(id);
    }
    return this.formulas.get(id) as InnerFormulas;
  }

  extent(id: SheetId): { rows: number; cols: number } {
    let e = this.extents.get(id);
    if (!e) {
      let rows = 0;
      let cols = 0;
      for (const [key, cell] of this.byId.get(id)?.cells ?? []) {
        if (cell.input === "") continue;
        rows = Math.max(rows, keyRow(key) + 1);
        cols = Math.max(cols, keyCol(key) + 1);
      }
      e = { rows, cols };
      this.extents.set(id, e);
    }
    return e;
  }

  context(sheetId: SheetId): EvalContext {
    let ctx = this.contexts.get(sheetId);
    if (!ctx) {
      ctx = {
        sheetId,
        value: (id, row, col) => this.values.get(id)?.get(cellKey(row, col))?.value ?? null,
        extent: (id) => this.extent(id),
        sheetIdByName: (name) => this.byName.get(name.toLowerCase()) ?? null,
        sheetSize: (id) => {
          const s = this.byId.get(id);
          return { rowCount: s?.rowCount ?? 0, columnCount: s?.columnCount ?? 0 };
        },
        nowSerial: () => this.nowSerial,
        patternAt: (id, row, col) => {
          const key = cellKey(row, col);
          return (
            this.byId.get(id)?.cells.get(key)?.format?.numberFormat?.pattern ??
            this.values.get(id)?.get(key)?.pattern ??
            null
          );
        },
      };
      this.contexts.set(sheetId, ctx);
    }
    return ctx;
  }

  resolveSheet(ref: AreaRef, owner: SheetId): SheetId | null {
    return ref.sheet === null ? owner : (this.byName.get(ref.sheet.toLowerCase()) ?? null);
  }

  /** Re-reads one cell's input into the formula and value maps. Returns its formula node, if any. */
  load(sheetId: SheetId, key: number): FormulaNode | null {
    const cell = this.byId.get(sheetId)?.cells.get(key);
    const input = cell?.input ?? "";
    const formulas = this.writableFormulas(sheetId);
    const values = this.writableValues(sheetId);
    const parsed = parseInput(input);
    if (parsed.kind === "formula") {
      const compiled = compileFormula(parsed.formula);
      formulas.set(key, compiled);
      return { sheetId, key, compiled };
    }
    formulas.delete(key);
    const lit = literalComputed(input);
    if (lit) values.set(key, lit);
    else values.delete(key);
    return null;
  }

  toCalc(): Calc {
    return { options: this.options, values: this.values, formulas: this.formulas };
  }

  /** Evaluates the given formulas in dependency order; cycles get #CYCLE!. */
  evaluate(nodes: ReadonlyArray<FormulaNode>): void {
    // Index dirty formulas by sheet and column to find precedents among them.
    const bySheet = new Map<SheetId, Map<number, FormulaNode>>();
    const byColumn = new Map<SheetId, Map<number, FormulaNode[]>>();
    for (const n of nodes) {
      let m = bySheet.get(n.sheetId);
      if (!m) bySheet.set(n.sheetId, (m = new Map()));
      m.set(n.key, n);
      let cols = byColumn.get(n.sheetId);
      if (!cols) byColumn.set(n.sheetId, (cols = new Map()));
      const col = keyCol(n.key);
      let list = cols.get(col);
      if (!list) cols.set(col, (list = []));
      list.push(n);
    }
    const precedents = (n: FormulaNode): FormulaNode[] => {
      const out: FormulaNode[] = [];
      for (const ref of n.compiled.refs) {
        const target = this.resolveSheet(ref, n.sheetId);
        if (target === null) continue;
        if (ref.single) {
          const hit = bySheet.get(target)?.get(cellKey(ref.startRow as number, ref.startCol as number));
          if (hit) out.push(hit);
          continue;
        }
        for (const [col, list] of byColumn.get(target) ?? []) {
          if ((ref.startCol !== null && col < ref.startCol) || (ref.endCol !== null && col > ref.endCol)) continue;
          for (const m of list) {
            const row = keyRow(m.key);
            if ((ref.startRow === null || row >= ref.startRow) && (ref.endRow === null || row <= ref.endRow)) {
              out.push(m);
            }
          }
        }
      }
      return out;
    };

    const index = new Map<FormulaNode, number>();
    const low = new Map<FormulaNode, number>();
    const onStack = new Set<FormulaNode>();
    const stack: FormulaNode[] = [];
    let counter = 0;
    interface Frame {
      readonly node: FormulaNode;
      readonly succ: FormulaNode[];
      i: number;
    }
    for (const root of nodes) {
      if (index.has(root)) continue;
      const frames: Frame[] = [];
      const enter = (n: FormulaNode) => {
        index.set(n, counter);
        low.set(n, counter);
        counter++;
        stack.push(n);
        onStack.add(n);
        frames.push({ node: n, succ: precedents(n), i: 0 });
      };
      enter(root);
      while (frames.length > 0) {
        const frame = frames[frames.length - 1] as Frame;
        if (frame.i < frame.succ.length) {
          const w = frame.succ[frame.i++] as FormulaNode;
          if (!index.has(w)) enter(w);
          else if (onStack.has(w)) {
            low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(w) as number));
          }
          continue;
        }
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) {
          low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
        }
        if (low.get(frame.node) !== index.get(frame.node)) continue;
        const scc: FormulaNode[] = [];
        for (;;) {
          const m = stack.pop() as FormulaNode;
          onStack.delete(m);
          scc.push(m);
          if (m === frame.node) break;
        }
        if (scc.length > 1 || frame.succ.includes(frame.node)) {
          for (const m of scc) this.writableValues(m.sheetId).set(m.key, { value: err("#CYCLE!"), pattern: null });
        } else {
          this.evaluateOne(frame.node);
        }
      }
    }
  }

  private evaluateOne(n: FormulaNode): void {
    const values = this.writableValues(n.sheetId);
    const ast = n.compiled.ast;
    if (!ast) {
      values.set(n.key, { value: err("#ERROR!"), pattern: null });
      return;
    }
    const ctx = this.context(n.sheetId);
    const value = evaluateCell(ast, ctx);
    const pattern = typeof value === "number" ? impliedPattern(ast, ctx) : null;
    values.set(n.key, { value, pattern });
  }

  allFormulaNodes(): FormulaNode[] {
    const out: FormulaNode[] = [];
    for (const [sheetId, m] of this.formulas) {
      for (const [key, compiled] of m) out.push({ sheetId, key, compiled });
    }
    return out;
  }
}

/** Builds formulas and values for a whole workbook. */
export function computeAll(sheets: ReadonlyArray<Sheet>, options: Required<EngineOptions>): Calc {
  const work = new Work(sheets, options, null);
  const nodes: FormulaNode[] = [];
  for (const s of sheets) {
    for (const key of s.cells.keys()) {
      const n = work.load(s.id, key);
      if (n) nodes.push(n);
    }
  }
  work.evaluate(nodes);
  return work.toCalc();
}

export interface Recalculated {
  readonly calc: Calc;
  /** Cells whose computed value or implied pattern changed. */
  readonly changed: ReadonlyArray<{ readonly sheetId: SheetId; readonly key: number }>;
}

/**
 * Re-evaluates after cells changed in place (same sheets, nothing moved):
 * the changed cells, every formula that depends on them, and volatile formulas.
 */
export function recalcChanged(
  prev: Calc,
  sheets: ReadonlyArray<Sheet>,
  changedCells: ReadonlyArray<{ readonly sheetId: SheetId; readonly key: number }>,
): Recalculated {
  const work = new Work(sheets, prev.options, prev);
  const dirty = new Map<string, FormulaNode>();
  const id = (sheetId: SheetId, key: number) => `${sheetId}|${key}`;
  for (const c of changedCells) {
    const n = work.load(c.sheetId, c.key);
    if (n) dirty.set(id(c.sheetId, c.key), n);
  }

  // Reverse index over all formulas: who reads a cell.
  const singles = new Map<string, FormulaNode[]>();
  const ranges = new Map<SheetId, Array<{ area: Area; node: FormulaNode }>>();
  const volatile: FormulaNode[] = [];
  for (const node of work.allFormulaNodes()) {
    if (node.compiled.volatile) volatile.push(node);
    for (const ref of node.compiled.refs) {
      const target = work.resolveSheet(ref, node.sheetId);
      if (target === null) continue;
      if (ref.single) {
        const k = id(target, cellKey(ref.startRow as number, ref.startCol as number));
        const list = singles.get(k);
        if (list) list.push(node);
        else singles.set(k, [node]);
      } else {
        let list = ranges.get(target);
        if (!list) ranges.set(target, (list = []));
        list.push({ area: ref, node });
      }
    }
  }

  const queue: Array<{ sheetId: SheetId; key: number }> = [...changedCells];
  const seen = new Set<string>(changedCells.map((c) => id(c.sheetId, c.key)));
  const mark = (node: FormulaNode) => {
    const k = id(node.sheetId, node.key);
    if (!dirty.has(k)) dirty.set(k, node);
    if (!seen.has(k)) {
      seen.add(k);
      queue.push({ sheetId: node.sheetId, key: node.key });
    }
  };
  for (const node of volatile) mark(node);
  for (let qi = 0; qi < queue.length; qi++) {
    const { sheetId, key } = queue[qi] as { sheetId: SheetId; key: number };
    for (const node of singles.get(id(sheetId, key)) ?? []) mark(node);
    const row = keyRow(key);
    const col = keyCol(key);
    for (const { area, node } of ranges.get(sheetId) ?? []) {
      if (areaContains(area, row, col)) mark(node);
    }
  }

  work.evaluate([...dirty.values()]);

  const changed: Array<{ sheetId: SheetId; key: number }> = [];
  for (const k of seen) {
    const bar = k.lastIndexOf("|");
    const sheetId = k.slice(0, bar);
    const key = Number(k.slice(bar + 1));
    const before = prev.values.get(sheetId)?.get(key);
    const after = work.values.get(sheetId)?.get(key);
    if (!sameComputed(before, after)) changed.push({ sheetId, key });
  }
  return { calc: work.toCalc(), changed };
}

export function sameScalar(a: Scalar, b: Scalar): boolean {
  if (isError(a) || isError(b)) return isError(a) && isError(b) && a.error === b.error;
  return a === b;
}

export function sameComputed(a: Computed | undefined, b: Computed | undefined): boolean {
  if (!a || !b) return a === b;
  return sameScalar(a.value, b.value) && a.pattern === b.pattern;
}
