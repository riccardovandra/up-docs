import { describe, expect, it } from "vitest";

import { createDiagramCache, type DiagramRender } from "./diagramCache.ts";

const rendered = (source: string): DiagramRender => ({
  status: "rendered",
  svg: `<svg>${source}</svg>`,
});

function countingRenderer(render: (source: string) => Promise<DiagramRender>) {
  const calls: string[] = [];
  return {
    calls,
    render: (source: string) => {
      calls.push(source);
      return render(source);
    },
  };
}

describe("createDiagramCache", () => {
  it("renders each source once and serves later views synchronously", async () => {
    const renderer = countingRenderer(async (source) => rendered(source));
    const cache = createDiagramCache(renderer.render);

    expect(cache.peek("a")).toBeUndefined();
    const [first, second] = await Promise.all([cache.get("a"), cache.get("a")]);
    expect(first).toEqual(rendered("a"));
    expect(second).toBe(first);
    expect(cache.peek("a")).toBe(first);
    await cache.get("b");
    expect(renderer.calls).toEqual(["a", "b"]);
  });

  it("caches syntax errors like diagrams", async () => {
    const error: DiagramRender = { status: "error", message: "Syntax error on line 2" };
    const renderer = countingRenderer(async () => error);
    const cache = createDiagramCache(renderer.render);

    expect(await cache.get("graph ??")).toBe(error);
    expect(cache.peek("graph ??")).toBe(error);
    await cache.get("graph ??");
    expect(renderer.calls).toHaveLength(1);
  });

  it("reports a renderer that failed to load, then retries it", async () => {
    let fail = true;
    const renderer = countingRenderer(async (source) => {
      if (fail) throw new Error("chunk failed");
      return rendered(source);
    });
    const cache = createDiagramCache(renderer.render);

    expect(await cache.get("a")).toEqual({
      status: "error",
      message: "The diagram renderer failed to load.",
    });
    expect(cache.peek("a")).toBeUndefined();
    fail = false;
    expect(await cache.get("a")).toEqual(rendered("a"));
    expect(renderer.calls).toEqual(["a", "a"]);
  });

  it("evicts the least recently used source past capacity", async () => {
    const renderer = countingRenderer(async (source) => rendered(source));
    const cache = createDiagramCache(renderer.render, 2);

    await cache.get("a");
    await cache.get("b");
    cache.peek("a");
    await cache.get("c");
    expect(cache.peek("a")).toEqual(rendered("a"));
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("c")).toEqual(rendered("c"));
  });
});
