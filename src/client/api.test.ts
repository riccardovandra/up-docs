import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./api.ts";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly size: number | null;
}

/** Answers like the upload routes. `onPart` can fail a part by returning a response. */
function stubServer(partBytes: number, onPart?: (attempt: number) => Response | Error | null) {
  const calls: Array<Call> = [];
  let attempts = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, size: init.body instanceof Blob ? init.body.size : null });
    if (method === "PUT") {
      attempts += 1;
      const outcome = onPart?.(attempts) ?? null;
      if (outcome instanceof Error) throw outcome;
      if (outcome) return outcome;
      return Response.json({ etag: `e${new URL(url, "https://x").searchParams.get("part")}` });
    }
    if (method === "DELETE") return Response.json({ ok: true });
    return url.endsWith("/videos")
      ? Response.json({ file: "f.mp4", uploadId: "up/1", partBytes }, { status: 201 })
      : Response.json({ url: "/api/videos/d/f.mp4" }, { status: 201 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const video = (size: number) => new File([new Uint8Array(size)], "a.mp4", { type: "video/mp4" });

describe("uploadVideo", () => {
  it("slices the file into parts, reports progress and completes", async () => {
    const calls = stubServer(4);
    const progress: Array<number> = [];
    const url = await api.uploadVideo("d", video(10), (fraction) => progress.push(fraction));
    expect(url).toBe("/api/videos/d/f.mp4");
    expect(calls.map(({ method, size }) => [method, size])).toEqual([
      ["POST", null],
      ["PUT", 4],
      ["PUT", 4],
      ["PUT", 2],
      ["POST", null],
    ]);
    expect(calls[1]!.url).toBe("/api/docs/d/videos/f.mp4?uploadId=up%2F1&part=1");
    expect(progress).toEqual([1 / 3, 2 / 3, 1]);
  });

  it("retries a failed part", async () => {
    vi.useFakeTimers();
    const calls = stubServer(4, (attempt) => {
      if (attempt === 1) return new TypeError("network");
      return attempt === 2 ? Response.json({}, { status: 503 }) : null;
    });
    const upload = api.uploadVideo("d", video(4), () => undefined);
    await vi.runAllTimersAsync();
    await expect(upload).resolves.toBe("/api/videos/d/f.mp4");
    expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(3);
  });

  it("aborts when a part keeps failing", async () => {
    vi.useFakeTimers();
    const calls = stubServer(4, () => Response.json({}, { status: 500 }));
    const upload = api.uploadVideo("d", video(4), () => undefined);
    const failed = expect(upload).rejects.toBeInstanceOf(ApiError);
    await vi.runAllTimersAsync();
    await failed;
    expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(3);
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "/api/docs/d/videos/f.mp4?uploadId=up%2F1",
    });
  });

  it("does not retry a refusal", async () => {
    const calls = stubServer(4, () => Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(api.uploadVideo("d", video(4), () => undefined)).rejects.toMatchObject({
      status: 403,
    });
    expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });

  it("refuses an unsupported file without calling the server", async () => {
    const calls = stubServer(4);
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await expect(api.uploadVideo("d", file, () => undefined)).rejects.toMatchObject({
      status: 415,
    });
    expect(calls).toEqual([]);
  });
});
