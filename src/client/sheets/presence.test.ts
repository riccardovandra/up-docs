import { describe, expect, it } from "vitest";

import type { SheetPresence, SheetRoomMessage } from "../../shared/sheets.ts";
import {
  agentOverlays,
  cellRects,
  EMPTY_PRESENCE,
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

const fold = (messages: ReadonlyArray<SheetRoomMessage>, state: PresenceState = EMPTY_PRESENCE) =>
  messages.reduce(presenceReducer, state);

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
    expect(presenceOverlays(state, "t1", dims)).toEqual([
      { key: "presence-c-bob", sheetId: "t1", rect: { r1: 1, c1: 1, r2: 3, c2: 2 }, color: "var(--sheet-person-4)", label: "Bob" },
    ]);
    expect(presenceOverlays(state, "t2", dims)).toHaveLength(1);
  });

  it("spans whole rows and columns to the tab's size", () => {
    const state = fold([
      snapshot(person("c-me", "ann"), [
        person("c-r", "bob", { tabId: "t1", range: "3:5", activeCell: "A3" }),
        person("c-c", "bob", { tabId: "t1", range: "B:C", activeCell: "B1" }),
      ]),
    ]);
    expect(presenceOverlays(state, "t1", { rows: 50, cols: 10 }).map((o) => o.rect)).toEqual([
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

describe("agent tags", () => {
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
