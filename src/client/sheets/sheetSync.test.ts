import { describe, expect, it } from "vitest";

import { applyEdits, isRefusal } from "../../shared/sheet/workbook.ts";
import { fresh, inputAt, valueAt } from "../../shared/sheet/testing.ts";
import type { Edit, Workbook } from "../../shared/sheet/types.ts";
import type { SheetAuthor, SheetRoomMessage } from "../../shared/sheets.ts";
import type { EditsOutcome } from "./sheetsApi.ts";
import { SheetSync } from "./sheetSync.ts";

const ME = "client-me";
const person: SheetAuthor = { userId: "u2", name: "Ada", kind: "person" };
const agent: SheetAuthor = { userId: "u3", name: "Claude", kind: "agent" };

const write = (topLeft: string, value: string): Edit => ({
  kind: "writeCells",
  sheet: "Sheet1",
  topLeft,
  rows: [[value]],
});

/** A fake server: one workbook, applying lists in order, broadcasting each. */
function harness(start: Workbook = fresh()) {
  let server = start;
  const posts: Array<{
    base: number;
    edits: ReadonlyArray<Edit>;
    resolve: (outcome: EditsOutcome) => void;
  }> = [];
  const broadcasts: Array<Extract<SheetRoomMessage, { type: "sheet.revision" }>> = [];
  let fetches = 0;
  const timers: Array<() => void> = [];
  const remote: Array<{ by: SheetAuthor; cells: number }> = [];

  /** Applies a list on the server as `origin` and returns its broadcast. */
  const serverApply = (edits: ReadonlyArray<Edit>, origin: string | null, by: SheetAuthor) => {
    const base = server.revision;
    const applied = applyEdits(server, base, edits);
    if (isRefusal(applied)) throw new Error(applied.detail);
    server = applied.workbook;
    const message = {
      type: "sheet.revision" as const,
      revision: applied.revision,
      base,
      edits,
      origin,
      by,
    };
    broadcasts.push(message);
    return message;
  };

  const sync = new SheetSync(start, {
    clientId: ME,
    post: (base, edits) =>
      new Promise<EditsOutcome>((resolve) => posts.push({ base, edits, resolve })),
    fetch: async () => {
      fetches += 1;
      return server;
    },
    onRemote: (change) => remote.push({ by: change.by, cells: change.changed.cells.length }),
    setTimer: (run) => {
      timers.push(run);
      return timers.length;
    },
    clearTimer: () => undefined,
  });

  /** The server's answer to the oldest open POST, as the real one would give it. */
  const answer = () => {
    const post = posts.shift();
    if (!post) throw new Error("no POST open");
    if (post.base !== server.revision) {
      post.resolve({ kind: "stale", revision: server.revision });
      return null;
    }
    const message = serverApply(post.edits, ME, person);
    post.resolve({ kind: "applied", revision: message.revision });
    return message;
  };

  return {
    sync,
    posts,
    broadcasts,
    timers,
    remote,
    serverApply,
    answer,
    get server() {
      return server;
    },
    get fetches() {
      return fetches;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SheetSync", () => {
  it("shows a local edit at once and sends one list at a time", async () => {
    const h = harness();
    h.sync.apply([write("A1", "1")]);
    h.sync.apply([write("A2", "2")]);
    expect(valueAt(h.sync.view, "Sheet1", "A1")).toBe(1);
    expect(valueAt(h.sync.view, "Sheet1", "A2")).toBe(2);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.base).toBe(0);
    expect(h.sync.pendingCount).toBe(2);

    const first = h.answer();
    await flush();
    // The 200 confirmed it; its own broadcast arriving later changes nothing.
    expect(h.sync.confirmed.revision).toBe(1);
    if (first) h.sync.receive(first);
    expect(h.sync.confirmed.revision).toBe(1);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.base).toBe(1);
    h.answer();
    await flush();
    expect(h.sync.pendingCount).toBe(0);
    expect(h.sync.confirmed.revision).toBe(2);
    expect(inputAt(h.sync.view, "Sheet1", "A2")).toBe("2");
  });

  it("confirms its own list from the broadcast that beats the POST answer", async () => {
    const h = harness();
    h.sync.apply([write("A1", "x")]);
    const post = h.posts.shift();
    if (!post) throw new Error("no post");
    const message = h.serverApply(post.edits, ME, person);
    h.sync.receive(message);
    expect(h.sync.pendingCount).toBe(0);
    expect(h.sync.confirmed.revision).toBe(1);
    post.resolve({ kind: "applied", revision: 1 });
    await flush();
    expect(h.sync.confirmed.revision).toBe(1);
    expect(h.remote).toHaveLength(0);
  });

  it("rebases pending lists onto someone else's revision", async () => {
    const h = harness();
    h.sync.apply([write("B1", "=A1*2")]);
    // Ada's write lands first on the server.
    const foreign = h.serverApply([write("A1", "21")], "client-ada", person);
    h.sync.receive(foreign);
    expect(h.sync.confirmed.revision).toBe(1);
    // Our formula, still pending, now computes from Ada's value.
    expect(valueAt(h.sync.view, "Sheet1", "B1")).toBe(42);
    expect(h.remote).toEqual([{ by: person, cells: 1 }]);
  });

  it("resends against the newer revision after a 409", async () => {
    const h = harness();
    h.sync.apply([write("A1", "mine")]);
    const foreign = h.serverApply([write("C3", "theirs")], null, agent);
    expect(h.answer()).toBeNull(); // 409: base 0 is stale
    await flush();
    // Still behind: waits for the broadcast, sends nothing.
    expect(h.posts).toHaveLength(0);
    h.sync.receive(foreign);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.base).toBe(1);
    h.answer();
    await flush();
    expect(h.sync.pendingCount).toBe(0);
    expect(inputAt(h.sync.confirmed, "Sheet1", "A1")).toBe("mine");
    expect(inputAt(h.sync.confirmed, "Sheet1", "C3")).toBe("theirs");
  });

  it("fetches the sheet when the 409's broadcasts do not come", async () => {
    const h = harness();
    h.sync.apply([write("A1", "mine")]);
    h.serverApply([write("C3", "theirs")], null, agent); // broadcast lost
    h.answer();
    await flush();
    expect(h.timers).toHaveLength(1);
    h.timers.shift()?.();
    await flush();
    expect(h.fetches).toBe(1);
    expect(h.sync.confirmed.revision).toBe(1);
    expect(h.posts[0]?.base).toBe(1);
  });

  it("fetches again on a gap and replays what came during the fetch", async () => {
    const h = harness();
    const missed = h.serverApply([write("A1", "1")], null, agent);
    const next = h.serverApply([write("A2", "2")], null, agent);
    void missed;
    h.sync.receive(next); // base 1, but we are at 0
    expect(h.fetches).toBe(1);
    await flush();
    expect(h.sync.confirmed.revision).toBe(2);
    expect(valueAt(h.sync.view, "Sheet1", "A2")).toBe(2);
  });

  it("drops a list the server refuses and reports it", async () => {
    const refusals: string[] = [];
    let resolve: (outcome: EditsOutcome) => void = () => undefined;
    const sync = new SheetSync(fresh(), {
      clientId: ME,
      post: () => new Promise((r) => (resolve = r)),
      fetch: async () => fresh(),
      onRefused: (refusal) => refusals.push(refusal.refusal),
    });
    sync.apply([write("A1", "x")]);
    resolve({
      kind: "refused",
      refusal: {
        error: "edits_refused",
        refusal: "workbookFull",
        editIndex: 0,
        detail: "full",
        revision: 0,
      },
    });
    await flush();
    expect(sync.pendingCount).toBe(0);
    expect(inputAt(sync.view, "Sheet1", "A1")).toBe("");
    expect(refusals).toEqual(["workbookFull"]);
  });

  it("does not send a list twice when its answer was lost but it landed", async () => {
    const h = harness();
    h.sync.apply([{ kind: "insertRows", sheet: "Sheet1", besideRow: 1, side: "before", count: 1 }]);
    const post = h.posts.shift();
    if (!post) throw new Error("no post");
    const message = h.serverApply(post.edits, ME, person);
    post.resolve({ kind: "failed" });
    await flush();
    // Waiting to retry; then the broadcast says it landed.
    h.sync.receive(message);
    h.timers.shift()?.();
    await flush();
    expect(h.posts).toHaveLength(0);
    expect(h.sync.pendingCount).toBe(0);
    expect(h.sync.confirmed.sheets[0]?.rowCount).toBe(1001);
  });

  it("keeps writes to a new tab when someone else's revision lands first", async () => {
    const h = harness();
    const added = h.sync.apply([{ kind: "addSheet", name: "Plan" }]);
    if (isRefusal(added)) throw new Error(added.detail);
    const tabId = added.workbook.sheets[1]?.id as string;
    h.sync.apply([{ kind: "writeCells", sheet: tabId, topLeft: "A1", rows: [["kept"]] }]);
    // Ada lands first: the server gives the new tab a later revision's id.
    h.sync.receive(h.serverApply([write("Z9", "x")], "client-ada", person));
    expect(h.answer()).toBeNull(); // 409 for our addSheet at base 0
    await flush();
    h.answer(); // addSheet again at base 1
    await flush();
    h.answer(); // the write, now naming the tab's new id
    await flush();
    expect(h.sync.pendingCount).toBe(0);
    expect(inputAt(h.server, "Plan", "A1")).toBe("kept");
    expect(inputAt(h.sync.view, "Plan", "A1")).toBe("kept");
  });
});
