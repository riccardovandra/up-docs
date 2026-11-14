import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagramRefresh, DiagramSummary } from "../../shared/drawio.ts";
import { createDiagramRefresher, DIAGRAM_REFRESH_MS } from "./diagramRefresh.ts";
import { diagramsApi, subscribeDiagram } from "./diagramsApi.ts";
import { fakeApi, summary, view } from "./testing/fakeDrawio.ts";

/**
 * A page showing diagrams: the real notice board and refresher over the fake
 * API, with the tab's visibility and its focus events in the test's hands.
 */
function page(diagrams: Parameters<typeof fakeApi>[0] = []) {
  const api = fakeApi(diagrams);
  const tab = { visible: true };
  const wakers = new Set<() => void>();
  const refresher = createDiagramRefresher({
    api,
    visible: () => tab.visible,
    onWake: (wake) => {
      wakers.add(wake);
      return () => wakers.delete(wake);
    },
  });
  const stops: Array<() => void> = [];
  /** A block or picture of the diagram: it watches, and records what the board tells it. */
  const show = (diagramId: string) => {
    const heard: Array<DiagramSummary | null> = [];
    stops.push(
      refresher.watch(diagramId),
      subscribeDiagram(diagramId, (diagram) => heard.push(diagram)),
    );
    return heard;
  };
  /** The window gets the focus, or the tab is shown again. */
  const wake = () => {
    for (const waker of [...wakers]) waker();
  };
  const close = () => {
    for (const stop of stops.splice(0)) stop();
  };
  return { api, tab, refresher, show, wake, close, stops, listening: () => wakers.size };
}

/** Lets a re-read's answer land: the fake API answers a microtask later. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const tick = () => vi.advanceTimersByTimeAsync(DIAGRAM_REFRESH_MS);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a change made somewhere else", () => {
  it("reaches every block of the diagram on a re-read, without its source", async () => {
    const { api, refresher, show, close } = page([
      view({ id: "g1", version: 1, pictureVersion: 1 }),
    ]);
    const first = show("g1");
    const second = show("g1");

    // An agent saves a new source: the version moves on and the picture is behind.
    api.diagrams.set("g1", view({ id: "g1", version: 2, pictureVersion: 1, title: "Renamed" }));
    await refresher.refresh();

    for (const heard of [first, second]) {
      expect(heard).toEqual([
        expect.objectContaining({ version: 2, pictureVersion: 1, title: "Renamed", canEdit: true }),
      ]);
      expect(heard[0]).not.toHaveProperty("xml");
      expect(heard[0]).not.toHaveProperty("usage");
    }
    // One request for the page, each diagram once, however many blocks show it.
    expect(api.reads).toEqual([["g1"]]);
    close();
  });

  it("shows a diagram deleted elsewhere as missing, and leaves the others alone", async () => {
    const { api, refresher, show, close } = page([view({ id: "g1" }), view({ id: "g2" })]);
    const kept = show("g1");
    const gone = show("g2");
    api.diagrams.delete("g2");
    await refresher.refresh();
    expect(gone).toEqual([null]);
    expect(kept).toEqual([expect.objectContaining({ id: "g1" })]);
    close();
  });

  it("tells someone who only views the diagram that they still only view it", async () => {
    const { api, refresher, show, close } = page([view({ id: "g1", canEdit: false, xml: null })]);
    const heard = show("g1");
    const found: Array<DiagramRefresh | undefined> = [];
    const stop = refresher.subscribe((seen) => found.push(seen.get("g1")));
    api.diagrams.set("g1", view({ id: "g1", version: 2, canEdit: false, xml: null }));
    await refresher.refresh();
    expect(heard).toEqual([expect.objectContaining({ version: 2, canEdit: false })]);
    // And nothing about where it is linked: that is for someone who manages it.
    expect(found).toEqual([expect.objectContaining({ usage: null })]);
    stop();
    close();
  });

  it("hands out where a diagram is linked now, for the line under a block", async () => {
    const { api, refresher, show, close } = page([view({ id: "g1" })]);
    show("g1");
    const lines: Array<number | undefined> = [];
    const stop = refresher.subscribe((seen) => lines.push(seen.get("g1")?.usage?.otherDocs));
    await refresher.refresh();
    // Linked into a second doc from another tab.
    api.usage.set("g1", { uses: [], otherDocs: 1 });
    await refresher.refresh();
    expect(lines).toEqual([0, 1]);
    stop();
    close();
  });

  it("keeps what the page shows when the server cannot be reached, and asks again", async () => {
    const { api, refresher, show, close } = page([view({ id: "g1" })]);
    const heard = show("g1");
    api.fail.summaries = new Error("offline");
    await refresher.refresh();
    expect(heard).toEqual([]);
    await tick();
    expect(heard).toHaveLength(1);
    close();
  });
});

describe("a save on this page that crosses a re-read", () => {
  it("is not undone by the older answer", async () => {
    const { api, refresher, show, close } = page([view({ id: "g1", version: 1 })]);
    const heard = show("g1");
    const lists: Array<number> = [];
    const stop = refresher.subscribe((seen) => lists.push(seen.size));
    // The re-read's answer is held back until the save has landed.
    const read = api.summaries;
    let answer = () => {};
    api.summaries = async (ids) => {
      const found = await read(ids);
      await new Promise<void>((resolve) => (answer = resolve));
      return found;
    };
    const reread = refresher.refresh();
    await settle();
    // The real API call, so the board hears the save exactly as it does on a page.
    vi.stubGlobal("fetch", async () => Response.json({ diagram: view({ id: "g1", version: 2 }) }));
    await diagramsApi.update("g1", { xml: "<mxGraphModel/>", baseVersion: 1 });
    answer();
    await reread;
    api.summaries = read;

    // Only the save was told: the re-read left before it and still says version 1.
    expect(heard.map((diagram) => diagram?.version)).toEqual([2]);
    // A list still re-reads itself; a block gets nothing from this turn.
    expect(lists).toEqual([0]);

    api.diagrams.set("g1", view({ id: "g1", version: 2 }));
    await tick();
    expect(heard.map((diagram) => diagram?.version)).toEqual([2, 2]);
    stop();
    close();
  });
});

describe("the page's timer", () => {
  it("asks every interval while the tab can be seen, and not while it is hidden", async () => {
    const { api, tab, show, close } = page([view({ id: "g1" }), view({ id: "g2" })]);
    show("g1");
    show("g2");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(DIAGRAM_REFRESH_MS - 1);
    expect(api.reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.reads).toEqual([["g1", "g2"]]);

    tab.visible = false;
    await tick();
    await tick();
    expect(api.reads).toHaveLength(1);

    tab.visible = true;
    await tick();
    expect(api.reads).toHaveLength(2);
    // Still one timer for the page, not one per block.
    expect(vi.getTimerCount()).toBe(1);
    close();
  });

  it("asks at once when the window or the tab comes back, once for both events", async () => {
    const { api, tab, show, wake, close } = page([view({ id: "g1" })]);
    const heard = show("g1");
    tab.visible = false;
    await tick();
    wake();
    await settle();
    expect(api.reads).toEqual([]);

    api.diagrams.set("g1", view({ id: "g1", version: 2 }));
    tab.visible = true;
    // Visibility and focus, as a browser sends them.
    wake();
    wake();
    await settle();
    expect(api.reads).toHaveLength(1);
    expect(heard.at(-1)).toMatchObject({ version: 2 });
    close();
  });

  it("runs only while something on the page shows a diagram", async () => {
    const { api, refresher, show, close, listening } = page([view({ id: "g1" })]);
    expect(vi.getTimerCount()).toBe(0);
    expect(listening()).toBe(0);

    show("g1");
    const stop = refresher.subscribe(() => undefined);
    expect(vi.getTimerCount()).toBe(1);
    expect(listening()).toBe(1);

    close();
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(listening()).toBe(0);
    await tick();
    expect(api.reads).toEqual([]);
  });

  it("tells a list to re-read itself each turn without asking about any diagram", async () => {
    const { api, refresher } = page([view({ id: "g1" })]);
    let turns = 0;
    const stop = refresher.subscribe(() => (turns += 1));
    await tick();
    await tick();
    expect(turns).toBe(2);
    expect(api.reads).toEqual([]);
    stop();
  });

  it("re-reads once more when asked during a re-read, as the editor closing does", async () => {
    const { api, refresher, show, close } = page([view({ id: "g1", version: 1 })]);
    const heard = show("g1");
    const first = refresher.refresh();
    // The first request has left; the server changes; the overlay closes and asks again.
    api.diagrams.set("g1", view({ id: "g1", version: 2 }));
    const second = refresher.refresh();
    await Promise.all([first, second]);
    expect(api.reads).toHaveLength(2);
    expect(heard.at(-1)).toMatchObject({ version: 2 });
    close();
  });
});

describe("the fake API's re-read", () => {
  it("answers like the route: summaries without a source, absent when not there", async () => {
    const api = fakeApi([view({ id: "g1", xml: "<mxGraphModel/>" })]);
    const found = await api.summaries(["g1", "gone"]);
    expect(found).toEqual([
      { ...summary({ id: "g1" }), canEdit: true, role: "owner", usage: { uses: [], otherDocs: 0 } },
    ]);
  });
});
