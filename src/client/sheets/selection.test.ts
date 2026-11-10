import { describe, expect, it } from "vitest";

import {
  cellSelection,
  dataEdge,
  headerSelection,
  moveSelection,
  selectionFromLabel,
  selectionLabel,
  selectionRect,
  type Selection,
} from "./selection.ts";

const dims = { rows: 1000, cols: 26 };
const filled = new Set(["0:0", "1:0", "2:0", "5:0", "0:1", "0:2"]);
const isFilled = (row: number, col: number) => filled.has(`${row}:${col}`);
const key = (k: string, mods: { shift?: boolean; mod?: boolean } = {}) => ({
  key: k,
  shift: mods.shift ?? false,
  mod: mods.mod ?? false,
});
const at = (row: number, col: number) => cellSelection({ row, col });

describe("moveSelection", () => {
  it("moves and clamps with arrows", () => {
    expect(moveSelection(at(0, 0), key("ArrowUp"), dims, isFilled)).toEqual(at(0, 0));
    expect(moveSelection(at(0, 0), key("ArrowRight"), dims, isFilled)).toEqual(at(0, 1));
    expect(moveSelection(at(999, 25), key("ArrowDown"), dims, isFilled)).toEqual(at(999, 25));
  });

  it("extends from the focus with shift and keeps the anchor", () => {
    const one = moveSelection(at(1, 1), key("ArrowDown", { shift: true }), dims, isFilled) as Selection;
    const two = moveSelection(one, key("ArrowRight", { shift: true }), dims, isFilled) as Selection;
    expect(two.anchor).toEqual({ row: 1, col: 1 });
    expect(selectionLabel(two, dims)).toBe("B2:C3");
  });

  it("jumps to the data edge with Cmd/Ctrl+arrow", () => {
    expect(moveSelection(at(0, 0), key("ArrowDown", { mod: true }), dims, isFilled)).toEqual(at(2, 0));
    expect(moveSelection(at(2, 0), key("ArrowDown", { mod: true }), dims, isFilled)).toEqual(at(5, 0));
    expect(moveSelection(at(5, 0), key("ArrowDown", { mod: true }), dims, isFilled)).toEqual(at(999, 0));
    expect(moveSelection(at(0, 0), key("ArrowRight", { mod: true }), dims, isFilled)).toEqual(at(0, 2));
  });

  it("returns to the column a run of Tabs started from on Enter", () => {
    let selection = at(3, 1);
    selection = moveSelection(selection, key("Tab"), dims, isFilled) as Selection;
    selection = moveSelection(selection, key("Tab"), dims, isFilled) as Selection;
    expect(selection.anchor).toEqual({ row: 3, col: 3 });
    selection = moveSelection(selection, key("Enter"), dims, isFilled) as Selection;
    expect(selection.anchor).toEqual({ row: 4, col: 1 });
    expect(moveSelection(selection, key("Enter", { shift: true }), dims, isFilled)?.anchor).toEqual({
      row: 3,
      col: 1,
    });
  });

  it("goes to the row's start and its last filled cell with Home and End", () => {
    expect(moveSelection(at(0, 5), key("Home"), dims, isFilled)).toEqual(at(0, 0));
    expect(moveSelection(at(0, 0), key("End"), dims, isFilled)).toEqual(at(0, 2));
    expect(moveSelection(at(9, 9), key("Home", { mod: true }), dims, isFilled)).toEqual(at(0, 0));
    expect(moveSelection(at(0, 0), key("End", { mod: true }), dims, isFilled)).toEqual(at(5, 2));
  });

  it("ignores other keys", () => {
    expect(moveSelection(at(0, 0), key("a"), dims, isFilled)).toBeNull();
  });
});

describe("headers and the name box", () => {
  it("selects whole rows and columns, extended with shift", () => {
    const column = headerSelection(at(0, 0), "columns", 2, false, dims);
    expect(selectionLabel(column, dims)).toBe("C:C");
    const columns = headerSelection(column, "columns", 4, true, dims);
    expect(selectionLabel(columns, dims)).toBe("C:E");
    expect(selectionRect(columns, dims)).toEqual({ r1: 0, c1: 2, r2: 999, c2: 4 });
    const rows = headerSelection(at(0, 0), "rows", 1, false, dims);
    expect(selectionLabel(headerSelection(rows, "rows", 3, true, dims), dims)).toBe("2:4");
  });

  it("reads an address typed in the name box", () => {
    expect(selectionFromLabel("b2", dims)).toEqual(at(1, 1));
    expect(selectionLabel(selectionFromLabel("A1:C4", dims) as Selection, dims)).toBe("A1:C4");
    expect(selectionFromLabel("C:C", dims)?.kind).toBe("columns");
    expect(selectionFromLabel("hello world", dims)).toBeNull();
  });

  it("stops at the edge when the next cell is outside", () => {
    expect(dataEdge({ row: 0, col: 0 }, -1, 0, dims, isFilled)).toEqual({ row: 0, col: 0 });
  });
});
