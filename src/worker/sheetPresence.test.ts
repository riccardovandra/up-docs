import { describe, expect, it } from "vitest";

import {
  parseSheetClientMessage,
  presenceColorIndex,
  PRESENCE_COLORS,
  type SheetRoomMessage,
} from "../shared/sheets.ts";
import {
  joinPresence,
  leavePresence,
  PRESENCE_BURST,
  PRESENCE_WINDOW_MS,
  receivePresence,
  type PresenceHost,
  type PresenceSocket,
} from "./sheetPresence.ts";

/** A hibernatable socket as the room sees it: a tag, an attachment and what it was sent. */
class FakeSocket implements PresenceSocket {
  readonly sent: SheetRoomMessage[] = [];
  private stored: string | null = null;
  readonly tag: string | null;
  constructor(tag: string | null) {
    this.tag = tag;
  }
  send(message: string) {
    this.sent.push(JSON.parse(message) as SheetRoomMessage);
  }
  // Stored as JSON, like the runtime's structured clone: nothing survives by reference.
  serializeAttachment(value: unknown) {
    this.stored = value === null ? null : JSON.stringify(value);
  }
  deserializeAttachment() {
    return this.stored === null ? null : (JSON.parse(this.stored) as unknown);
  }
  take() {
    return this.sent.splice(0);
  }
}

function room() {
  const sockets: FakeSocket[] = [];
  const names: Record<string, string> = { ann: "Ann", bob: "Bob" };
  let now = 1_000_000;
  /** A fresh host each call, like a room woken from hibernation: nothing kept in memory. */
  const host = (): PresenceHost<FakeSocket> => ({
    sockets: () => sockets,
    userOf: (socket) => socket.tag,
    nameOf: async (userId) => names[userId] ?? "",
    now: () => now,
  });
  const open = async (userId: string) => {
    const socket = new FakeSocket(userId);
    sockets.push(socket);
    await joinPresence(host(), socket);
    return socket;
  };
  const close = (socket: FakeSocket) => {
    leavePresence(host(), socket);
    sockets.splice(sockets.indexOf(socket), 1);
  };
  const say = (socket: FakeSocket, message: unknown) =>
    receivePresence(host(), socket, typeof message === "string" ? message : JSON.stringify(message));
  return { sockets, host, open, close, say, tick: (ms: number) => (now += ms) };
}

const at = (range: string, activeCell = range.split(":")[0]!, tabId = "s0-0") => ({
  type: "presence",
  tabId,
  range,
  activeCell,
});

describe("sheet presence", () => {
  it("sends a joining page itself and everyone already here, and tells them it arrived", async () => {
    const r = room();
    const ann = await r.open("ann");
    const [first] = ann.take();
    expect(first).toMatchObject({
      type: "sheet.presence.snapshot",
      self: { userId: "ann", name: "Ann", colorIndex: presenceColorIndex("ann"), tabId: null },
      presences: [],
    });
    await r.say(ann, at("B2:C4", "B2"));

    const bob = await r.open("bob");
    const [snapshot] = bob.take();
    expect(snapshot).toMatchObject({
      type: "sheet.presence.snapshot",
      self: { userId: "bob", name: "Bob" },
      presences: [{ userId: "ann", name: "Ann", tabId: "s0-0", range: "B2:C4", activeCell: "B2" }],
    });
    expect(ann.take()).toEqual([
      expect.objectContaining({ type: "sheet.presence", userId: "bob", range: null }),
    ]);
  });

  it("relays a selection to the others, never back to the sender", async () => {
    const r = room();
    const ann = await r.open("ann");
    const bob = await r.open("bob");
    ann.take();
    bob.take();
    await r.say(ann, at("D5"));
    expect(ann.take()).toEqual([]);
    expect(bob.take()).toEqual([
      expect.objectContaining({ type: "sheet.presence", userId: "ann", tabId: "s0-0", range: "D5", activeCell: "D5" }),
    ]);
    await r.say(ann, { type: "presence.clear" });
    expect(bob.take()).toEqual([
      expect.objectContaining({ type: "sheet.presence", userId: "ann", tabId: null, range: null }),
    ]);
  });

  it("takes the sender from the socket's tag, not from the message", async () => {
    const r = room();
    const ann = await r.open("ann");
    const bob = await r.open("bob");
    bob.take();
    await r.say(ann, { ...at("A1"), userId: "bob", name: "Bob", connectionId: "x", colorIndex: 3 });
    const [message] = bob.take();
    const annSelf = (ann.sent[0] as Extract<SheetRoomMessage, { type: "sheet.presence.snapshot" }>).self;
    expect(message).toEqual({ type: "sheet.presence", ...annSelf, tabId: "s0-0", range: "A1", activeCell: "A1" });
  });

  it("shows the same person in two windows as two presences with one name and colour", async () => {
    const r = room();
    const one = await r.open("ann");
    const two = await r.open("ann");
    const [snapshot] = two.take();
    if (snapshot?.type !== "sheet.presence.snapshot") throw new Error("no snapshot");
    expect(snapshot.presences).toHaveLength(1);
    expect(snapshot.presences[0]!.connectionId).not.toBe(snapshot.self.connectionId);
    expect(snapshot.presences[0]!.colorIndex).toBe(snapshot.self.colorIndex);
    expect(one.take().at(-1)).toMatchObject({ type: "sheet.presence", userId: "ann" });
  });

  it("announces a closed page to the others, once", async () => {
    const r = room();
    const ann = await r.open("ann");
    const bob = await r.open("bob");
    bob.take();
    const annId = (ann.sent[0] as Extract<SheetRoomMessage, { type: "sheet.presence.snapshot" }>).self.connectionId;
    leavePresence(r.host(), ann); // the error handler and then the close handler
    r.close(ann);
    expect(bob.take()).toEqual([{ type: "sheet.presence.left", connectionId: annId }]);
    const carol = await r.open("ann");
    const [snapshot] = carol.take();
    expect(snapshot).toMatchObject({ presences: [{ userId: "bob" }] });
  });

  it("keeps everyone's place across hibernation, in the socket attachments", async () => {
    const r = room();
    const ann = await r.open("ann");
    await r.say(ann, at("C3", "C3", "tab-2"));
    // Every call above and below builds a new host: only the attachments carry state.
    const bob = await r.open("bob");
    expect(bob.take()[0]).toMatchObject({ presences: [{ userId: "ann", tabId: "tab-2", range: "C3" }] });
  });

  it("joins a socket that has no presence yet (opened before presence) on its first message", async () => {
    const r = room();
    const bob = await r.open("bob");
    bob.take();
    const old = new FakeSocket("ann");
    r.sockets.push(old);
    await r.say(old, at("E1"));
    expect(old.sent[0]).toMatchObject({ type: "sheet.presence.snapshot", self: { userId: "ann" } });
    expect(bob.take()).toEqual([
      expect.objectContaining({ userId: "ann", range: null }),
      expect.objectContaining({ userId: "ann", range: "E1" }),
    ]);
    const untagged = new FakeSocket(null);
    r.sockets.push(untagged);
    await r.say(untagged, at("A1"));
    expect(untagged.sent).toEqual([]);
    expect(bob.take()).toEqual([]);
  });

  it("drops a flood beyond the burst, and takes updates again in the next window", async () => {
    const r = room();
    const ann = await r.open("ann");
    const bob = await r.open("bob");
    bob.take();
    for (let row = 1; row <= PRESENCE_BURST + 5; row += 1) await r.say(ann, at(`A${row}`));
    expect(bob.take()).toHaveLength(PRESENCE_BURST);
    r.tick(PRESENCE_WINDOW_MS);
    await r.say(ann, at("Z9"));
    expect(bob.take()).toEqual([expect.objectContaining({ range: "Z9" })]);
  });

  it("drops messages that are not presence, or malformed", async () => {
    const r = room();
    const ann = await r.open("ann");
    const bob = await r.open("bob");
    bob.take();
    for (const bad of [
      "ping",
      "not json",
      { type: "writeCells" },
      { type: "presence", tabId: "s0-0", range: "B2" },
      at("A0"),
      at("B2:", "B2"),
      at("A1", "A1:B2"),
      at("A1", "A1", "bad id!"),
      { ...at("A1"), pad: "x".repeat(600) },
    ]) {
      await r.say(ann, bad);
    }
    expect(bob.take()).toEqual([]);
  });
});

describe("presence messages", () => {
  it("reads the ranges a selection can have", () => {
    for (const range of ["B2", "B2:C4", "3:5", "B:D", "AAA1000000"]) {
      expect(parseSheetClientMessage(JSON.stringify(at(range, "A1")))).toMatchObject({ range });
    }
  });

  it("gives a user the same colour every time, inside the palette", () => {
    for (const id of ["ann", "bob", "a-much-longer-user-id", ""]) {
      const index = presenceColorIndex(id);
      expect(index).toBe(presenceColorIndex(id));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PRESENCE_COLORS);
    }
  });
});
