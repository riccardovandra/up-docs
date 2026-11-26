import { describe, expect, it } from "vitest";

import { DesignSaver, type PendingSave, type SaveOutcome, type SaveStatus } from "./designSaver.ts";

const save = (seq: number): PendingSave => ({ seq, fig: new ArrayBuffer(seq), png: null });

function harness(start = 0) {
  const sent: Array<{ base: number; seq: number }> = [];
  const acks: Array<number> = [];
  const statuses: Array<SaveStatus["kind"]> = [];
  let answer: (outcome: SaveOutcome) => void = () => undefined;
  const saver = new DesignSaver(start, {
    send: (base, pending) => {
      sent.push({ base, seq: pending.seq });
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
    ack: (seq) => acks.push(seq),
    onStatus: (status) => statuses.push(status.kind),
    now: () => 1,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { saver, sent, acks, statuses, reply: (o: SaveOutcome) => answer(o), settle };
}

describe("DesignSaver", () => {
  it("saves one at a time, each on the version the last produced, newest waiting save only", async () => {
    const h = harness(3);
    h.saver.offer(save(1));
    h.saver.offer(save(2));
    h.saver.offer(save(3));
    // 2 is superseded by 3 while 1 is in flight.
    expect(h.acks).toEqual([2]);
    h.reply({ ok: true, version: 4 });
    await h.settle();
    h.reply({ ok: true, version: 5 });
    await h.settle();
    expect(h.sent).toEqual([
      { base: 3, seq: 1 },
      { base: 4, seq: 3 },
    ]);
    expect(h.acks).toEqual([2, 1, 3]);
    expect(h.saver.baseVersion).toBe(5);
    expect(h.saver.unsaved).toBe(false);
    expect(h.statuses.at(-1)).toBe("saved");
  });

  it("keeps a failed save for Retry", async () => {
    const h = harness(1);
    h.saver.offer(save(1));
    h.reply({ ok: false, message: "offline" });
    await h.settle();
    expect(h.saver.status).toMatchObject({ kind: "failed", conflict: false });
    expect(h.saver.unsaved).toBe(true);
    expect(h.acks).toEqual([]);
    h.saver.retry();
    h.reply({ ok: true, version: 2 });
    await h.settle();
    expect(h.sent.map((each) => each.seq)).toEqual([1, 1]);
    expect(h.acks).toEqual([1]);
    expect(h.saver.unsaved).toBe(false);
  });

  it("after a conflict, Retry saves on top of the newer version", async () => {
    const h = harness(1);
    h.saver.offer(save(1));
    h.reply({ ok: false, message: "stale", currentVersion: 7 });
    await h.settle();
    expect(h.saver.status).toMatchObject({ kind: "failed", conflict: true });
    h.saver.retry();
    h.reply({ ok: true, version: 8 });
    await h.settle();
    expect(h.sent).toEqual([
      { base: 1, seq: 1 },
      { base: 7, seq: 1 },
    ]);
  });

  it("a newer save replaces a failed one", async () => {
    const h = harness(1);
    h.saver.offer(save(1));
    h.reply({ ok: false, message: "offline" });
    await h.settle();
    h.saver.offer(save(2));
    expect(h.acks).toEqual([1]);
    h.reply({ ok: true, version: 2 });
    await h.settle();
    expect(h.sent.map((each) => each.seq)).toEqual([1, 2]);
    expect(h.saver.status.kind).toBe("saved");
  });
});
