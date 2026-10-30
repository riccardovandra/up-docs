import { describe, expect, it, vi } from "vitest";

import { DocSaver } from "./docSaver.ts";
import type { DocSaveResult, DocSnapshot, DocSource } from "./docSource.ts";

/** A file on "disk" that refuses saves based on a version it no longer has. */
function fakeSource(initial: string) {
  let disk = { markdown: initial, version: "v0" };
  let writes = 0;
  const source: DocSource = {
    load: async () => ({ ...disk, readOnlyReason: null }),
    save: async (markdown, baseVersion): Promise<DocSaveResult> => {
      if (baseVersion !== disk.version) {
        return { status: "conflict", current: { ...disk, readOnlyReason: null } };
      }
      writes += 1;
      disk = { markdown, version: `v${writes}` };
      return { status: "saved", version: disk.version };
    },
    subscribe: () => () => undefined,
  };
  return {
    source,
    disk: () => disk,
    editOnDisk: (markdown: string) => {
      disk = { markdown, version: `disk-${markdown}` };
    },
  };
}

const callbacks = () => ({
  onSaved: vi.fn<(version: string) => void>(),
  onConflict: vi.fn<(current: DocSnapshot) => void>(),
  onError: vi.fn<(cause: unknown) => void>(),
});

/** Fake timers for one test, restored when it ends. */
function fakeTimers() {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}

describe("DocSaver", () => {
  it("saves edits on top of the version it last saw", async () => {
    using _timers = fakeTimers();
    const file = fakeSource("# A\n");
    const events = callbacks();
    const saver = new DocSaver(file.source, "v0", events);
    saver.schedule("# A1\n");
    await saver.flush();
    saver.schedule("# A2\n");
    await saver.flush();
    expect(file.disk()).toEqual({ markdown: "# A2\n", version: "v2" });
    expect(events.onSaved.mock.calls).toEqual([["v1"], ["v2"]]);
    expect(saver.dirty).toBe(false);
  });

  it("never overwrites a file that changed on disk", async () => {
    using _timers = fakeTimers();
    const file = fakeSource("# A\n");
    const events = callbacks();
    const saver = new DocSaver(file.source, "v0", events);
    file.editOnDisk("# Agent\n");
    saver.schedule("# Mine\n");
    await saver.flush();
    expect(file.disk().markdown).toBe("# Agent\n");
    expect(events.onConflict).toHaveBeenCalledWith({
      markdown: "# Agent\n",
      version: "disk-# Agent\n",
      readOnlyReason: null,
    });
    expect(saver.dirty).toBe(false);
    // Edits after the reload build on the disk version.
    saver.schedule("# Agent and mine\n");
    await saver.flush();
    expect(file.disk().markdown).toBe("# Agent and mine\n");
  });

  it("keeps the edit and retries when the save fails", async () => {
    using _timers = fakeTimers();
    const file = fakeSource("# A\n");
    const events = callbacks();
    const save = file.source.save;
    let fail = true;
    const saver = new DocSaver(
      {
        ...file.source,
        save: (markdown, baseVersion) =>
          fail ? Promise.reject(new Error("offline")) : save(markdown, baseVersion),
      },
      "v0",
      events,
    );
    saver.schedule("# B\n");
    await saver.flush();
    expect(events.onError).toHaveBeenCalledOnce();
    expect(saver.pending).toBe(true);
    fail = false;
    await vi.runAllTimersAsync();
    expect(file.disk().markdown).toBe("# B\n");
  });
});
