import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api.ts";
import { createRedrawQueue } from "./redraw.ts";
import { fakeApi, fakeDrawio, PNG_BASE64, SVG, summary, view } from "./testing/fakeDrawio.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A queue over the stand-in frame. `init` is what a freshly loaded Draw.io says first. */
function setup(
  diagrams: Parameters<typeof fakeApi>[0],
  options: Parameters<typeof fakeDrawio>[0] = {},
) {
  const api = fakeApi(diagrams);
  const frames: Array<ReturnType<typeof fakeDrawio>> = [];
  const queue = createRedrawQueue({
    api,
    createFrame: () => {
      const drawio = fakeDrawio(options);
      frames.push(drawio);
      queueMicrotask(() => drawio.emit({ event: "init" }));
      return drawio.frame;
    },
  });
  return { api, frames, queue };
}

describe("redraw on demand", () => {
  it("draws a diagram with no picture and uploads it for the version it drew", async () => {
    const stored = view({ id: "g1", version: 3, xml: "<mxfile>3</mxfile>" });
    const { api, frames, queue } = setup([stored]);
    const redrawn = await queue.request("g1");

    expect(redrawn).toMatchObject({ id: "g1", version: 3, pictureVersion: 3 });
    expect(frames).toHaveLength(1);
    // Load first; the picture is asked for only once Draw.io says the diagram is on the canvas.
    expect(frames[0]!.posted.map((action) => action.action)).toEqual(["load", "export", "export"]);
    expect(frames[0]!.posted[0]).toEqual({ action: "load", xml: "<mxfile>3</mxfile>" });
    expect(api.calls).toEqual([
      ["uploadPicture", "g1", { version: 3, svg: SVG, png: PNG_BASE64 }],
    ]);
    expect(queue.isPending("g1")).toBe(false);
  });

  it("queues several diagrams through the one frame, in order", async () => {
    const { api, frames, queue } = setup([
      view({ id: "a", xml: "<mxfile>a</mxfile>" }),
      view({ id: "b", xml: "<mxfile>b</mxfile>", version: 2, pictureVersion: 1 }),
      view({ id: "c", xml: "<mxfile>c</mxfile>" }),
    ]);
    const seen: Array<boolean> = [];
    queue.subscribe(() => seen.push(queue.isPending("c")));
    const all = Promise.all(["a", "b", "c"].map((id) => queue.request(id)));
    expect(queue.isPending("a") && queue.isPending("c")).toBe(true);
    const results = await all;

    expect(results.map((diagram) => diagram.pictureVersion)).toEqual([1, 2, 1]);
    expect(frames).toHaveLength(1);
    expect(
      frames[0]!.posted.flatMap((action) => (action.action === "load" ? [action.xml] : [])),
    ).toEqual(["<mxfile>a</mxfile>", "<mxfile>b</mxfile>", "<mxfile>c</mxfile>"]);
    expect(api.calls.map((call) => call[1])).toEqual(["a", "b", "c"]);
    expect(seen.at(-1)).toBe(false);
  });

  it("returns the same redraw when asked twice, and draws nothing for a current one", async () => {
    const { api, frames, queue } = setup([
      view({ id: "stale" }),
      view({ id: "current", version: 2, pictureVersion: 2 }),
      view({ id: "empty", xml: "", hasSource: false }),
    ]);
    const first = queue.request("stale");
    expect(queue.request("stale")).toBe(first);
    await first;
    await queue.request("current");
    await queue.request("empty");
    expect(api.calls).toHaveLength(1);
    expect(frames[0]!.posted.filter((action) => action.action === "load")).toHaveLength(1);
  });

  it("refuses someone who only views the diagram, without loading Draw.io", async () => {
    const { frames, queue } = setup([view({ id: "g1", canEdit: false, xml: null })]);
    await expect(queue.request("g1")).rejects.toThrow("Only someone who manages");
    expect(frames).toHaveLength(0);
    await expect(queue.request("gone")).rejects.toBeInstanceOf(ApiError);
  });

  it("uploads the SVG alone when the browser makes no PNG", async () => {
    const { api, queue } = setup([view({ id: "g1" })], { png: false });
    const redrawn = queue.request("g1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await redrawn).pictureVersion).toBe(1);
    expect(api.calls).toEqual([["uploadPicture", "g1", { version: 1, svg: SVG, png: null }]]);
  });

  it("reports the diagram as it now is when it was saved again while drawing", async () => {
    const { api, queue } = setup([view({ id: "g1", version: 1 })]);
    const newer = summary({ id: "g1", version: 2, pictureVersion: null });
    api.fail.upload = new ApiError(409, {
      error: "version_conflict",
      version: 2,
      diagram: newer,
    } as never);
    expect(await queue.request("g1")).toEqual(newer);
  });

  it("gives up on a diagram Draw.io cannot open, and uses a fresh frame for the next", async () => {
    const { frames, queue } = setup([view({ id: "bad" }), view({ id: "good" })], { loads: false });
    const bad = queue.request("bad").then(
      () => "drawn",
      (cause: Error) => cause.message,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await bad).toBe("Draw.io did not open the diagram in time.");
    expect(frames[0]!.state.removed).toBe(true);

    const good = queue.request("good").then(
      () => "drawn",
      (cause: Error) => cause.message,
    );
    await vi.advanceTimersByTimeAsync(1);
    frames[1]!.emit({ event: "load" });
    expect(frames).toHaveLength(2);
    expect(await good).toBe("drawn");
  });

  it("removes the hidden frame once it has been idle for a while", async () => {
    const { frames, queue } = setup([view({ id: "g1" })]);
    await queue.request("g1");
    expect(frames[0]!.state.removed).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frames[0]!.state.removed).toBe(true);
  });
});
