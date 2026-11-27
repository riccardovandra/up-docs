import { describe, expect, it } from "vitest";

import {
  DESIGN_COMMAND_TIMEOUT_MS,
  DESIGN_TICKET_TTL_MS,
  DesignBridge,
  issueDesignTicket,
  MAX_DESIGN_TICKETS,
  spendDesignTicket,
  type BridgeSocket,
  type TicketStorage,
} from "./designBridge.ts";

/** A socket that records what the room sent it. */
function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const socket: BridgeSocket = { send: (data) => sent.push(JSON.parse(data)) };
  return { socket, sent };
}

/** A bridge on a hand-driven clock, sending to whichever socket `editor` holds. */
function bridgeWith(initial: BridgeSocket | null) {
  const holder = { editor: initial, id: "c1" };
  const timers = new Map<number, () => void>();
  let next = 0;
  const bridge = new DesignBridge({
    editor: () => (holder.editor ? { socket: holder.editor, id: holder.id } : null),
    setTimer: (run) => {
      next += 1;
      timers.set(next, run);
      return next;
    },
    clearTimer: (timer) => timers.delete(timer as number),
    newId: () => `r${++next}`,
  });
  const fireTimers = () => {
    for (const [id, run] of [...timers]) {
      timers.delete(id);
      run();
    }
  };
  return { bridge, holder, timers, fireTimers };
}

const answer = (id: unknown, body: Record<string, unknown>) =>
  JSON.stringify({ type: "response", id, ...body });

describe("DesignBridge", () => {
  it("forwards a command and resolves with the editor's answer", async () => {
    const editor = fakeSocket();
    const { bridge, timers } = bridgeWith(editor.socket);
    const pending = bridge.command("tool", { name: "create_shape", args: { type: "FRAME" } });
    expect(editor.sent).toEqual([
      {
        type: "request",
        id: expect.any(String),
        command: "tool",
        args: { name: "create_shape", args: { type: "FRAME" } },
      },
    ]);
    // Other messages the editor sends (its register prompt, junk) change nothing.
    bridge.receive(editor.socket, JSON.stringify({ type: "register", token: "x" }));
    bridge.receive(editor.socket, "not json");
    bridge.receive(editor.socket, new ArrayBuffer(4));
    bridge.receive(editor.socket, answer(editor.sent[0]!.id, { ok: true, result: { id: "1:2" } }));
    expect(await pending).toEqual({ kind: "answer", ok: true, result: { id: "1:2" }, editor: "c1" });
    expect(timers.size).toBe(0);
    expect(bridge.inFlight).toBe(0);
  });

  it("passes the editor's refusal on", async () => {
    const editor = fakeSocket();
    const { bridge } = bridgeWith(editor.socket);
    const pending = bridge.command("undo", {});
    bridge.receive(editor.socket, answer(editor.sent[0]!.id, { ok: false, error: "made in the editor" }));
    expect(await pending).toEqual({ kind: "answer", ok: false, error: "made in the editor", editor: "c1" });
  });

  it("answers not_open with no editor, and refuses eval and other commands without sending", async () => {
    expect(await bridgeWith(null).bridge.command("tool", {})).toEqual({ kind: "not_open" });
    const editor = fakeSocket();
    const { bridge } = bridgeWith(editor.socket);
    for (const command of ["eval", "open_document", "save_document", "get_settings", "x"]) {
      expect((await bridge.command(command, {})).kind).toBe("refused");
    }
    expect(editor.sent).toEqual([]);
  });

  it("times out after 20 s, and cancels the call in the editor", async () => {
    expect(DESIGN_COMMAND_TIMEOUT_MS).toBe(20_000);
    const editor = fakeSocket();
    const { bridge, fireTimers } = bridgeWith(editor.socket);
    const pending = bridge.command("tool", { name: "get_page_tree" });
    const id = editor.sent[0]!.id;
    fireTimers();
    expect(await pending).toEqual({ kind: "timeout" });
    expect(editor.sent[1]).toEqual({ type: "cancel", id });
    // A late answer is dropped.
    bridge.receive(editor.socket, answer(id, { ok: true, result: 1 }));
    expect(bridge.inFlight).toBe(0);
  });

  it("takes an answer only from the socket the request went to; the newest socket gets new calls", async () => {
    const old = fakeSocket();
    const { bridge, holder } = bridgeWith(old.socket);
    const first = bridge.command("selection", {});
    const newer = fakeSocket();
    holder.editor = newer.socket;
    holder.id = "c2";
    const second = bridge.command("selection", {});
    expect(old.sent).toHaveLength(1);
    expect(newer.sent).toHaveLength(1);
    // The newer socket cannot answer the older one's request, nor the other way round.
    bridge.receive(newer.socket, answer(old.sent[0]!.id, { ok: true, result: "wrong" }));
    bridge.receive(old.socket, answer(newer.sent[0]!.id, { ok: true, result: "wrong" }));
    expect(bridge.inFlight).toBe(2);
    // The older socket closing ends its own call only.
    bridge.dropped(old.socket);
    expect(await first).toEqual({ kind: "closed" });
    bridge.receive(newer.socket, answer(newer.sent[0]!.id, { ok: true, result: [] }));
    expect(await second).toEqual({ kind: "answer", ok: true, result: [], editor: "c2" });
  });

  it("sends to an expected connection only", async () => {
    const editor = fakeSocket();
    const { bridge, holder } = bridgeWith(editor.socket);
    expect(await bridge.command("tool", {}, "c0")).toEqual({ kind: "editor_changed" });
    expect(editor.sent).toEqual([]);
    const pending = bridge.command("tool", {}, holder.id);
    expect(editor.sent).toHaveLength(1);
    bridge.receive(editor.socket, answer(editor.sent[0]!.id, { ok: true, result: null }));
    expect((await pending).kind).toBe("answer");
  });

  it("ends a call whose send throws", async () => {
    const { bridge } = bridgeWith({
      send: () => {
        throw new Error("closed");
      },
    });
    expect(await bridge.command("tool", {})).toEqual({ kind: "closed" });
    expect(bridge.inFlight).toBe(0);
  });
});

function memoryStorage(): TicketStorage & { readonly map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => void map.set(key, value),
    delete: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      let count = 0;
      for (const key of list) if (map.delete(key)) count += 1;
      return Array.isArray(keys) ? count : count > 0;
    },
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...map].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
  };
}

describe("design tickets", () => {
  it("work once, within their time, in the room that issued them", async () => {
    const room = memoryStorage();
    const other = memoryStorage();
    const { ticket, expiresAt } = await issueDesignTicket(room, 1_000);
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(1_000 + DESIGN_TICKET_TTL_MS);
    // Another design's room never issued it.
    expect(await spendDesignTicket(other, ticket, 1_001)).toBe(false);
    expect(await spendDesignTicket(room, ticket, 1_001)).toBe(true);
    expect(await spendDesignTicket(room, ticket, 1_002)).toBe(false);

    const late = await issueDesignTicket(room, 2_000);
    expect(await spendDesignTicket(room, late.ticket, late.expiresAt)).toBe(false);
    // Spent by time: gone too.
    expect(await spendDesignTicket(room, late.ticket, 2_001)).toBe(false);
    for (const bad of ["", "a".repeat(63), "A".repeat(64), `${"a".repeat(64)}x`]) {
      expect(await spendDesignTicket(room, bad, 2_001)).toBe(false);
    }
  });

  it("keeps a bounded number, dropping expired and then the oldest", async () => {
    const room = memoryStorage();
    const first = await issueDesignTicket(room, 0);
    const tickets = [];
    for (let i = 1; i <= MAX_DESIGN_TICKETS + 5; i += 1) tickets.push(await issueDesignTicket(room, i));
    expect(room.map.size).toBe(MAX_DESIGN_TICKETS);
    expect(await spendDesignTicket(room, first.ticket, 30)).toBe(false);
    expect(await spendDesignTicket(room, tickets.at(-1)!.ticket, 30)).toBe(true);
    await issueDesignTicket(room, DESIGN_TICKET_TTL_MS + 1_000);
    expect(room.map.size).toBe(1);
  });
});
