import { describe, expect, it } from "vitest";

import { apply, fresh, inputAt, shownAt, write } from "../../shared/sheet/testing.ts";
import { findSheet } from "../../shared/sheet/workbook.ts";
import type { Edit } from "../../shared/sheet/types.ts";
import { chunkEdits, inverseOf, UndoStack } from "./undo.ts";

const formatOf = (workbook: ReturnType<typeof fresh>, row: number, col: number) =>
  findSheet(workbook, "Sheet1")?.cells.get(row * 32768 + col)?.format;

describe("inverseOf", () => {
  it("puts back inputs, blanks included", () => {
    const before = write(fresh(), "Sheet1", "A1", [["1", "=A1+1"]]);
    const edits: Edit[] = [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [["9", "x", "new"]] }];
    const inverse = inverseOf(before, edits);
    if (!inverse) throw new Error("no inverse");
    const after = apply(before, edits).workbook;
    const back = apply(after, inverse).workbook;
    expect(inputAt(back, "Sheet1", "A1")).toBe("1");
    expect(inputAt(back, "Sheet1", "B1")).toBe("=A1+1");
    expect(inputAt(back, "Sheet1", "C1")).toBe("");
  });

  it("removes the format a typed percent set", () => {
    const before = fresh();
    const edits: Edit[] = [{ kind: "writeCells", sheet: "Sheet1", topLeft: "B2", rows: [["10%"]] }];
    const after = apply(before, edits).workbook;
    expect(shownAt(after, "Sheet1", "B2")).toBe("10%");
    const inverse = inverseOf(before, edits);
    if (!inverse) throw new Error("no inverse");
    const back = apply(after, inverse).workbook;
    expect(inputAt(back, "Sheet1", "B2")).toBe("");
    expect(formatOf(back, 1, 1)).toBeUndefined();
  });

  it("restores exact formats after a format change", () => {
    const before = apply(fresh(), [
      { kind: "formatCells", sheet: "Sheet1", ranges: ["A1"], format: { font: { bold: true } } },
      { kind: "formatCells", sheet: "Sheet1", ranges: ["B1"], format: { fillColor: "#ffeeaa" } },
    ]).workbook;
    const edits: Edit[] = [
      {
        kind: "formatCells",
        sheet: "Sheet1",
        ranges: ["A1:C1"],
        format: { font: { italic: true }, numberFormat: { pattern: "0.0%" } },
      },
    ];
    const inverse = inverseOf(before, edits);
    if (!inverse) throw new Error("no inverse");
    const back = apply(apply(before, edits).workbook, inverse).workbook;
    expect(formatOf(back, 0, 0)).toEqual({ font: { bold: true } });
    expect(formatOf(back, 0, 1)).toEqual({ fillColor: "#ffeeaa" });
    expect(formatOf(back, 0, 2)).toBeUndefined();
  });

  it("does not undo structural edits", () => {
    expect(inverseOf(fresh(), [{ kind: "addSheet", name: "Two" }])).toBeNull();
  });
});

describe("UndoStack", () => {
  it("undoes and redoes through the caller's apply", () => {
    let workbook = fresh();
    const send = (edits: ReadonlyArray<Edit>) => {
      workbook = apply(workbook, edits).workbook;
      return true;
    };
    const stack = new UndoStack();
    const forward: Edit[] = [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [["hello"]] }];
    const inverse = inverseOf(workbook, forward);
    if (!inverse) throw new Error("no inverse");
    send(forward);
    stack.record({ forward, inverse, sheetId: "s0-0" });

    expect(stack.undo(send)).not.toBeNull();
    expect(inputAt(workbook, "Sheet1", "A1")).toBe("");
    expect(stack.redo(workbook, send)).not.toBeNull();
    expect(inputAt(workbook, "Sheet1", "A1")).toBe("hello");
    expect(stack.undo(send)).not.toBeNull();
    expect(inputAt(workbook, "Sheet1", "A1")).toBe("");
    expect(stack.canUndo).toBe(false);
  });
});

describe("chunkEdits", () => {
  it("splits a large paste into lists the server accepts", () => {
    const rows = Array.from({ length: 300 }, (_, row) => Array.from({ length: 10 }, (_, col) => `${row}-${col}`));
    const lists = chunkEdits([{ kind: "writeCells", sheet: "Sheet1", topLeft: "B2", rows }]);
    expect(lists).toHaveLength(3);
    const first = lists[0]?.[0];
    const second = lists[1]?.[0];
    expect(first?.kind === "writeCells" && first.rows.length).toBe(100);
    expect(second?.kind === "writeCells" && second.topLeft).toBe("B102");
    let workbook = fresh();
    for (const list of lists) workbook = apply(workbook, list).workbook;
    expect(inputAt(workbook, "Sheet1", "K301")).toBe("299-9");
  });
});
