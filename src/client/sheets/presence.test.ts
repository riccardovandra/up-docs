import { describe, expect, it } from "vitest";

import { apply, fresh } from "../../shared/sheet/testing.ts";
import type { Edit } from "../../shared/sheet/types.ts";
import { PRESENCE_EXPIRY_MS, type SheetPresence, type SheetRoomMessage } from "../../shared/sheets.ts";
import {
  agentOverlays,
  cellRects,
  changedCells,
  EMPTY_PRESENCE,
  nextTagChange,
  PRESENCE_TAG_MS,
  presenceAvatars,
  presenceMessage,
  presenceOverlays,
  presenceReducer,
  type PresenceState,
} from "./presence.ts";

const person = (connectionId: string, userId: string, extra: Partial<SheetPresence> = {}): SheetPresence => ({
  connectionId,
  userId,
  name: userId === "ann" ? "Ann" : "Bob",
  colorIndex: userId === "ann" ? 1 : 4,
  tabId: null,
  range: null,
  activeCell: null,
  ...extra,
});

const fold = (messages: ReadonlyArray<SheetRoomMessage>, state: PresenceState = EMPTY_PRESENCE, at = 0) =>
  messages.reduce((current, message) => presenceReducer(current, { kind: "message", message, at }), state);

const snapshot = (self: SheetPresence, presences: SheetPresence[]): SheetRoomMessage => ({
  type: "sheet.presence.snapshot",
  self,
  presences,
});
const moved = (presence: SheetPresence): SheetRoomMessage => ({ type: "sheet.presence", ...presence });
const dims = { rows: 1000, cols: 26 };

describe("presence state", () => {
  it("starts from the snapshot and follows joins, moves and leaves", () => {
    const me = person("c-me", "ann");
    let state = fold([snapshot(me, [person("c-bob", "bob", { tabId: "t1", range: "B2", activeCell: "B2" })])]);
    expect([...state.others.keys()]).toEqual(["c-bob"]);
    state = fold([moved(person("c-bob", "bob", { tabId: "t1", range: "C3:D4", activeCell: "C3" }))], state);
    expect(state.others.get("c-bob")?.range).toBe("C3:D4");
    state = fold([moved(person("c-ann2", "ann"))], state);
    expect(state.others.size).toBe(2);
    state = fold([{ type: "sheet.presence.left", connectionId: "c-bob" }], state);
    expect([...state.others.keys()]).toEqual(["c-ann2"]);
  });

  it("ignores its own presence echoed back, and messages that are not presence", () => {
    const me = person("c-me", "ann");
    const state = fold([snapshot(me, [])]);
    expect(fold([moved({ ...me, range: "A1" })], state)).toBe(state);
    expect(fold([{ type: "sheet.deleted", sheetId: "x", origin: null }], state)).toBe(state);
    expect(fold([{ type: "sheet.presence.left", connectionId: "nobody" }], state)).toBe(state);
  });

  it("drops stale cursors when a reconnect brings a new snapshot", () => {
    const before = fold([snapshot(person("c-1", "ann"), [person("c-bob", "bob"), person("c-old", "bob")])]);
    const after = fold([snapshot(person("c-2", "ann"), [person("c-bob", "bob")])], before);
    expect([...after.others.keys()]).toEqual(["c-bob"]);
    expect(after.self?.connectionId).toBe("c-2");
  });
});

describe("presence on the grid", () => {
  it("outlines others on the shown tab only, in their colour with their name", () => {
    const state = fold([
      snapshot(person("c-me", "ann"), [
        person("c-bob", "bob", { tabId: "t1", range: "B2:C4", activeCell: "B2" }),
        person("c-bob2", "bob", { tabId: "t2", range: "A1", activeCell: "A1" }),
        person("c-idle", "bob"),
      ]),
    ]);
    expect(presenceOverlays(state, "t1", dims, 0)).toEqual([
      {
        key: "presence-c-bob",
        sheetId: "t1",
        rect: { r1: 1, c1: 1, r2: 3, c2: 2 },
        color: "var(--sheet-person-4)",
        label: "Bob",
        labelShown: true,
      },
    ]);
    expect(presenceOverlays(state, "t2", dims, 0)).toHaveLength(1);
  });

  it("spans whole rows and columns to the tab's size", () => {
    const state = fold([
      snapshot(person("c-me", "ann"), [
        person("c-r", "bob", { tabId: "t1", range: "3:5", activeCell: "A3" }),
        person("c-c", "bob", { tabId: "t1", range: "B:C", activeCell: "B1" }),
      ]),
    ]);
    expect(presenceOverlays(state, "t1", { rows: 50, cols: 10 }, 0).map((o) => o.rect)).toEqual([
      { r1: 2, c1: 0, r2: 4, c2: 9 },
      { r1: 0, c1: 1, r2: 49, c2: 2 },
    ]);
  });

  it("shows one avatar per person, this page's person first", () => {
    const state = fold([
      snapshot(person("c-me", "ann"), [person("c-bob", "bob"), person("c-bob2", "bob"), person("c-ann2", "ann")]),
    ]);
    expect(presenceAvatars(state).map((a) => [a.userId, a.self])).toEqual([
      ["ann", true],
      ["bob", false],
    ]);
  });

  it("publishes a selection as A1 text with its active cell", () => {
    const selection = { anchor: { row: 3, col: 2 }, focus: { row: 1, col: 1 }, kind: "cells" as const };
    expect(presenceMessage("t1", selection, dims)).toEqual({
      type: "presence",
      tabId: "t1",
      range: "B2:C4",
      activeCell: "C4",
    });
    expect(presenceMessage("t1", { ...selection, kind: "rows" }, dims).range).toBe("2:4");
  });
});

describe("presence over time", () => {
  const bobAt = (range: string) => moved(person("c-bob", "bob", { tabId: "t1", range, activeCell: range }));

  it("shows a name tag for a while after the cursor moves, not after a heartbeat", () => {
    let state = fold([snapshot(person("c-me", "ann"), [])]);
    state = fold([bobAt("B2")], state, 1000);
    expect(presenceOverlays(state, "t1", dims, 1000 + PRESENCE_TAG_MS - 1)[0]?.labelShown).toBe(true);
    expect(nextTagChange(state, 1000)).toBe(1000 + PRESENCE_TAG_MS);
    // The same place again is a heartbeat: the tag stays hidden.
    state = fold([bobAt("B2")], state, 20_000);
    expect(presenceOverlays(state, "t1", dims, 20_000)[0]?.labelShown).toBe(false);
    expect(nextTagChange(state, 20_000)).toBeNull();
    state = fold([bobAt("C3")], state, 21_000);
    expect(presenceOverlays(state, "t1", dims, 21_000)[0]?.labelShown).toBe(true);
  });

  it("drops a cursor not heard of within the expiry, even without a left", () => {
    let state = fold([snapshot(person("c-me", "ann"), [person("c-dead", "ann", { tabId: "t1", range: "F9" })])], EMPTY_PRESENCE, 0);
    state = fold([bobAt("B2")], state, 30_000);
    const prune = (now: number) => presenceReducer(state, { kind: "prune", now });
    expect(prune(PRESENCE_EXPIRY_MS - 1)).toBe(state);
    state = prune(PRESENCE_EXPIRY_MS);
    expect([...state.others.keys()]).toEqual(["c-bob"]);
    // Bob's heartbeat keeps him.
    state = fold([bobAt("B2")], state, 50_000);
    expect([...prune(50_000 + PRESENCE_EXPIRY_MS - 1).others.keys()]).toEqual(["c-bob"]);
    expect(prune(50_000 + PRESENCE_EXPIRY_MS).others.size).toBe(0);
  });
});

describe("agent tags", () => {
  it("highlights the cells written after a row insert, at their final addresses", () => {
    const base = apply(fresh(), [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [["Item", "Cost"], ["Rent", 100]] },
    ]).workbook;
    const edits: Edit[] = [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "D1", rows: [["moved by the insert"]] },
      { kind: "insertRows", sheet: "Sheet1", besideRow: 1, side: "after", count: 1 },
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A2", rows: [["Fees", 20]] },
      { kind: "formatCells", sheet: "Sheet1", ranges: ["B2"], format: { font: { bold: true } } },
    ];
    const applied = apply(base, edits);
    expect(applied.changed.cells).toEqual([]);
    expect(changedCells(edits, applied.workbook, applied.changed)).toEqual([
      { sheetId: "s0-0", row: 1, col: 0 },
      { sheetId: "s0-0", row: 1, col: 1 },
    ]);
  });

  it("keeps the engine's cells for tabs that were not rebuilt", () => {
    const base = apply(fresh(), [{ kind: "addSheet", name: "Other" }]).workbook;
    const edits: Edit[] = [
      { kind: "writeCells", sheet: "Other", topLeft: "C3", rows: [[1]] },
      { kind: "deleteRows", sheet: "Sheet1", rows: [5] },
    ];
    const applied = apply(base, edits);
    expect(changedCells(edits, applied.workbook, applied.changed)).toEqual([{ sheetId: "s1-0", row: 2, col: 2 }]);
  });

  it("covers a written block with one rectangle and scattered cells with several", () => {
    const block = [0, 1, 2].flatMap((row) => [1, 2].map((col) => ({ row, col })));
    expect(cellRects(block)).toEqual([{ r1: 0, c1: 1, r2: 2, c2: 2 }]);
    expect(cellRects([{ row: 0, col: 0 }, { row: 5, col: 5 }, { row: 0, col: 1 }])).toEqual([
      { r1: 0, c1: 0, r2: 0, c2: 1 },
      { r1: 5, c1: 5, r2: 5, c2: 5 },
    ]);
  });

  it("falls back to the bounding box for a change too scattered to outline cell by cell", () => {
    const cells = Array.from({ length: 60 }, (_, i) => ({ row: i * 2, col: i % 3 }));
    expect(cellRects(cells)).toEqual([{ r1: 0, c1: 0, r2: 118, c2: 2 }]);
  });

  it("tags an agent's change with its name, once per tab", () => {
    const by = { userId: "u1", name: "Robin", kind: "agent" as const };
    const overlays = agentOverlays("7", by, [
      { sheetId: "t1", row: 0, col: 0 },
      { sheetId: "t1", row: 4, col: 4 },
      { sheetId: "t2", row: 1, col: 1 },
    ]);
    expect(overlays.map((o) => [o.sheetId, o.label ?? null])).toEqual([
      ["t1", "Robin (agent)"],
      ["t1", null],
      ["t2", "Robin (agent)"],
    ]);
    expect(agentOverlays("8", { ...by, name: "" }, [{ sheetId: "t1", row: 0, col: 0 }])[0]?.label).toBe("Agent");
  });
});
