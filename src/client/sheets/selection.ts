// Selection on one tab: an active cell (the anchor), the far corner of the
// range (the focus), and whether whole rows or columns are picked. Pure, so the
// keyboard rules are tested without a browser. Rows and columns are 0-based.

import { columnToLetters, formatArea, parseArea } from "../../shared/sheet/address.ts";

export interface CellRef {
  readonly row: number;
  readonly col: number;
}

/** Inclusive, normalised: r1 <= r2, c1 <= c2. */
export interface Rect {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

export type SelectionKind = "cells" | "rows" | "columns";

export interface Selection {
  /** The active cell: where typing goes. */
  readonly anchor: CellRef;
  /** The opposite corner of the range. */
  readonly focus: CellRef;
  readonly kind: SelectionKind;
  /** The column a run of Tab presses started from; Enter returns to it on the next row. */
  readonly tabStart?: number;
}

export interface Dims {
  readonly rows: number;
  readonly cols: number;
}

export const cellSelection = (cell: CellRef): Selection => ({
  anchor: cell,
  focus: cell,
  kind: "cells",
});

const clamp = (value: number, max: number) => Math.max(0, Math.min(max - 1, value));
const clampCell = (cell: CellRef, dims: Dims): CellRef => ({
  row: clamp(cell.row, dims.rows),
  col: clamp(cell.col, dims.cols),
});

export function selectionRect(selection: Selection, dims: Dims): Rect {
  const { anchor, focus, kind } = selection;
  const r1 = kind === "columns" ? 0 : Math.min(anchor.row, focus.row);
  const r2 = kind === "columns" ? dims.rows - 1 : Math.max(anchor.row, focus.row);
  const c1 = kind === "rows" ? 0 : Math.min(anchor.col, focus.col);
  const c2 = kind === "rows" ? dims.cols - 1 : Math.max(anchor.col, focus.col);
  return { r1, c1, r2, c2 };
}

export const rectContains = (rect: Rect, row: number, col: number) =>
  row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2;

export const rectCells = (rect: Rect) => (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);

export const isSingleCell = (selection: Selection) =>
  selection.kind === "cells" &&
  selection.anchor.row === selection.focus.row &&
  selection.anchor.col === selection.focus.col;

/** A1 text for the name box: "B2", "A1:C4", "3:5" or "B:D". */
export function selectionLabel(selection: Selection, dims: Dims): string {
  const rect = selectionRect(selection, dims);
  if (selection.kind === "rows") return `${rect.r1 + 1}:${rect.r2 + 1}`;
  if (selection.kind === "columns") return `${columnToLetters(rect.c1)}:${columnToLetters(rect.c2)}`;
  return formatArea({ startRow: rect.r1, startCol: rect.c1, endRow: rect.r2, endCol: rect.c2 });
}

/** The selection a name-box entry asks for, or null when it is not an address. */
export function selectionFromLabel(text: string, dims: Dims): Selection | null {
  const area = parseArea(text.trim().toUpperCase());
  if (!area) return null;
  if (area.startRow === null && area.startCol !== null && area.endCol !== null) {
    return {
      anchor: { row: 0, col: clamp(area.startCol, dims.cols) },
      focus: { row: dims.rows - 1, col: clamp(area.endCol, dims.cols) },
      kind: "columns",
    };
  }
  if (area.startCol === null && area.startRow !== null && area.endRow !== null) {
    return {
      anchor: { row: clamp(area.startRow, dims.rows), col: 0 },
      focus: { row: clamp(area.endRow, dims.rows), col: dims.cols - 1 },
      kind: "rows",
    };
  }
  if (area.startRow === null || area.startCol === null) return null;
  const anchor = clampCell({ row: area.startRow, col: area.startCol }, dims);
  const focus = clampCell(
    { row: area.endRow ?? area.startRow, col: area.endCol ?? area.startCol },
    dims,
  );
  return { anchor, focus, kind: "cells" };
}

/**
 * Ctrl/Cmd+arrow: from a filled cell with a filled neighbour, to the last
 * filled cell of the run; otherwise to the next filled cell, or the edge.
 */
export function dataEdge(
  from: CellRef,
  dRow: number,
  dCol: number,
  dims: Dims,
  isFilled: (row: number, col: number) => boolean,
): CellRef {
  const inside = (row: number, col: number) =>
    row >= 0 && row < dims.rows && col >= 0 && col < dims.cols;
  let row = from.row + dRow;
  let col = from.col + dCol;
  if (!inside(row, col)) return from;
  if (isFilled(from.row, from.col) && isFilled(row, col)) {
    while (inside(row + dRow, col + dCol) && isFilled(row + dRow, col + dCol)) {
      row += dRow;
      col += dCol;
    }
    return { row, col };
  }
  while (!isFilled(row, col) && inside(row + dRow, col + dCol)) {
    row += dRow;
    col += dCol;
  }
  return { row, col };
}

export interface KeyInput {
  readonly key: string;
  readonly shift: boolean;
  /** Cmd on a Mac, Ctrl elsewhere. */
  readonly mod: boolean;
}

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * The selection after a navigation key, or null when the key does not move it.
 * `isFilled` says whether a cell has input, for jumps to the data edge and End.
 */
export function moveSelection(
  selection: Selection,
  input: KeyInput,
  dims: Dims,
  isFilled: (row: number, col: number) => boolean,
): Selection | null {
  const { key, shift, mod } = input;
  const arrow = ARROWS[key];
  if (arrow) {
    const [dRow, dCol] = arrow;
    const from = shift ? selection.focus : selection.anchor;
    const to = mod
      ? dataEdge(from, dRow, dCol, dims, isFilled)
      : clampCell({ row: from.row + dRow, col: from.col + dCol }, dims);
    if (!shift) return cellSelection(to);
    // Extending a row selection moves only rows; a column selection only columns.
    if (selection.kind === "rows") return { ...selection, focus: { ...selection.focus, row: to.row } };
    if (selection.kind === "columns") {
      return { ...selection, focus: { ...selection.focus, col: to.col } };
    }
    return { anchor: selection.anchor, focus: to, kind: "cells" };
  }
  if (key === "Tab") {
    const col = clamp(selection.anchor.col + (shift ? -1 : 1), dims.cols);
    const tabStart = shift ? undefined : (selection.tabStart ?? selection.anchor.col);
    return {
      ...cellSelection({ row: selection.anchor.row, col }),
      ...(tabStart === undefined ? {} : { tabStart }),
    };
  }
  if (key === "Enter") {
    const row = clamp(selection.anchor.row + (shift ? -1 : 1), dims.rows);
    return cellSelection({ row, col: shift ? selection.anchor.col : (selection.tabStart ?? selection.anchor.col) });
  }
  if (key === "Home") {
    const to = mod ? { row: 0, col: 0 } : { row: selection.anchor.row, col: 0 };
    return shift ? { anchor: selection.anchor, focus: to, kind: "cells" } : cellSelection(to);
  }
  if (key === "End") {
    const lastIn = (row: number) => {
      for (let col = dims.cols - 1; col > 0; col--) if (isFilled(row, col)) return col;
      return 0;
    };
    let to: CellRef;
    if (mod) {
      let lastRow = 0;
      let lastCol = 0;
      for (let row = 0; row < dims.rows; row++) {
        const col = lastIn(row);
        if (col > 0 || isFilled(row, 0)) {
          lastRow = row;
          lastCol = Math.max(lastCol, col);
        }
      }
      to = { row: lastRow, col: lastCol };
    } else {
      to = { row: selection.anchor.row, col: lastIn(selection.anchor.row) };
    }
    return shift ? { anchor: selection.anchor, focus: to, kind: "cells" } : cellSelection(to);
  }
  if (key === "PageDown" || key === "PageUp") {
    const step = key === "PageDown" ? 20 : -20;
    return cellSelection(clampCell({ row: selection.anchor.row + step, col: selection.anchor.col }, dims));
  }
  return null;
}

/** A click on a cell, or a shift-click that extends from the active cell. */
export function clickCell(selection: Selection, cell: CellRef, shift: boolean): Selection {
  return shift ? { anchor: selection.anchor, focus: cell, kind: "cells" } : cellSelection(cell);
}

/** Header clicks: whole rows or columns, extended by shift. */
export function headerSelection(
  selection: Selection,
  kind: "rows" | "columns",
  index: number,
  shift: boolean,
  dims: Dims,
): Selection {
  if (kind === "rows") {
    const anchorRow = shift && selection.kind === "rows" ? selection.anchor.row : index;
    return {
      anchor: { row: anchorRow, col: 0 },
      focus: { row: index, col: dims.cols - 1 },
      kind: "rows",
    };
  }
  const anchorCol = shift && selection.kind === "columns" ? selection.anchor.col : index;
  return {
    anchor: { row: 0, col: anchorCol },
    focus: { row: dims.rows - 1, col: index },
    kind: "columns",
  };
}

/** Keeps a selection inside the tab after it shrank. */
export function clampSelection(selection: Selection, dims: Dims): Selection {
  return {
    ...selection,
    anchor: clampCell(selection.anchor, dims),
    focus: clampCell(selection.focus, dims),
  };
}
