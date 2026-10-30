import { describe, expect, it } from "vitest";

import type { DocRole } from "../shared/access.ts";
import { MAX_VIDEO_BYTES, MAX_VIDEO_PARTS, VIDEO_PART_BYTES } from "../shared/video.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { handleApi } from "./api.ts";
import { makeApiHarness, ORIGIN } from "./testing/apiHarness.ts";
import { parseRange, r2VideoStore } from "./videos.ts";

const MP4 = new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);
const MOV = new TextEncoder().encode("\0\0\0\x14ftypqt  ....");
const OLD_MOV = new TextEncoder().encode("\0\0\0\x08wide....");
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

async function setup(overrides: Parameters<typeof makeApiHarness>[0] = {}) {
  const api = makeApiHarness(overrides);
  const owner = await api.signIn();
  const created = (await (
    await api.call("POST", "/api/docs", { body: { title: "Plan" }, headers: { Cookie: owner } })
  ).json()) as DocWithTabs;
  const docId = created.doc.id;
  const person = async (email: string, role: DocRole) => {
    await api.call("POST", `/api/docs/${docId}/members`, {
      body: { email, role },
      headers: { Cookie: owner },
    });
    return api.signIn(email);
  };
  const start = (cookie: string, body: unknown = { type: "video/mp4", size: MP4.length }) =>
    api.call("POST", `/api/docs/${docId}/videos`, { body, headers: { Cookie: cookie } });
  const part = (
    cookie: string,
    file: string,
    uploadId: string,
    partNumber: number | string,
    bytes: Uint8Array,
    origin = ORIGIN,
  ) =>
    handleApi(
      new Request(
        `${ORIGIN}/api/docs/${docId}/videos/${file}?uploadId=${uploadId}&part=${partNumber}`,
        {
          method: "PUT",
          headers: {
            Origin: origin,
            Cookie: cookie,
            "Content-Length": String(bytes.length),
          },
          body: bytes.slice(),
        },
      ),
      api.deps,
    );
  const complete = (cookie: string, file: string, uploadId: string, count = 1) =>
    api.call("POST", `/api/docs/${docId}/videos/${file}`, {
      body: {
        uploadId,
        parts: Array.from({ length: count }, (_, index) => ({
          partNumber: index + 1,
          etag: `etag-${index + 1}`,
        })),
      },
      headers: { Cookie: cookie },
    });
  /** The whole path: start, one part per chunk, complete. */
  const upload = async (cookie: string, chunks: ReadonlyArray<Uint8Array>, type = "video/mp4") => {
    const { file, uploadId } = (await (
      await start(cookie, {
        type,
        size: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      })
    ).json()) as { file: string; uploadId: string };
    for (const [index, chunk] of chunks.entries()) {
      expect((await part(cookie, file, uploadId, index + 1, chunk)).status).toBe(200);
    }
    return { file, uploadId, response: await complete(cookie, file, uploadId, chunks.length) };
  };
  return { api, owner, docId, person, start, part, complete, upload };
}

describe("video upload routes", () => {
  it("starts, stores parts and completes, and serves the result to viewers", async () => {
    const { api, owner, docId, person, start, part, complete } = await setup();
    const editor = await person("e@example.com", "editor");
    const started = await start(editor);
    expect(started.status).toBe(201);
    const { file, uploadId, partBytes } = (await started.json()) as {
      file: string;
      uploadId: string;
      partBytes: number;
    };
    expect(file).toMatch(/\.mp4$/);
    expect(partBytes).toBe(VIDEO_PART_BYTES);

    const stored = await part(editor, file, uploadId, 1, MP4.subarray(0, 12));
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ partNumber: 1, etag: "etag-1" });
    await part(editor, file, uploadId, 2, MP4.subarray(12));

    const done = await complete(editor, file, uploadId, 2);
    expect(done.status).toBe(201);
    const { url } = (await done.json()) as { url: string };
    expect(url).toBe(`/api/videos/${docId}/${file}`);
    expect([...api.videos.keys()]).toEqual([`videos/${docId}/${file}`]);

    const viewer = await person("v@example.com", "viewer");
    for (const cookie of [owner, viewer]) {
      const served = await api.call("GET", url, { headers: { Cookie: cookie } });
      expect(served.status).toBe(200);
      expect(served.headers.get("Content-Type")).toBe("video/mp4");
      expect(served.headers.get("Accept-Ranges")).toBe("bytes");
      expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(served.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      expect(served.headers.get("Cache-Control")).toContain("immutable");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(MP4);
    }
  });

  it("accepts each allowed type", async () => {
    const { owner, upload } = await setup();
    for (const [bytes, type] of [
      [MOV, "video/quicktime"],
      [OLD_MOV, "video/quicktime"],
      [WEBM, "video/webm"],
    ] as const) {
      expect((await upload(owner, [bytes], type)).response.status).toBe(201);
    }
  });

  it("aborts an upload, and a part after that finds nothing", async () => {
    const { api, owner, docId, start, part } = await setup();
    const { file, uploadId } = (await (await start(owner)).json()) as {
      file: string;
      uploadId: string;
    };
    await part(owner, file, uploadId, 1, MP4);
    const aborted = await api.call(
      "DELETE",
      `/api/docs/${docId}/videos/${file}?uploadId=${uploadId}`,
      { headers: { Cookie: owner } },
    );
    expect(aborted.status).toBe(200);
    expect(api.uploads.size).toBe(0);
    const late = await part(owner, file, uploadId, 2, MP4);
    expect(late.status).toBe(404);
    expect(await late.json()).toEqual({ error: "upload_not_found" });
  });

  it("refuses bad leading bytes and removes the object", async () => {
    const { api, owner, upload } = await setup();
    for (const [bytes, type] of [
      [HTML, "video/mp4"],
      [HTML, "video/quicktime"],
      [MP4, "video/webm"],
      [WEBM, "video/mp4"],
      [MP4.subarray(0, 8), "video/mp4"],
    ] as const) {
      const { response } = await upload(owner, [bytes], type);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_video" });
    }
    expect(api.videos.size).toBe(0);
  });

  it("enforces the size cap at start, on each part and on the finished object", async () => {
    const { api, owner, docId, start, complete } = await setup();
    expect((await start(owner, { type: "video/mp4", size: MAX_VIDEO_BYTES + 1 })).status).toBe(413);
    expect((await start(owner, { type: "video/mp4", size: MAX_VIDEO_BYTES })).status).toBe(201);
    for (const size of [0, -1, 1.5, "10", undefined]) {
      expect((await start(owner, { type: "video/mp4", size })).status).toBe(400);
    }

    const { file, uploadId } = (await (await start(owner)).json()) as {
      file: string;
      uploadId: string;
    };
    const oversized = await handleApi(
      new Request(`${ORIGIN}/api/docs/${docId}/videos/${file}?uploadId=${uploadId}&part=1`, {
        method: "PUT",
        headers: {
          Origin: ORIGIN,
          Cookie: owner,
          "Content-Length": String(VIDEO_PART_BYTES + 1),
        },
        body: MP4.slice(),
      }),
      api.deps,
    );
    expect(oversized.status).toBe(413);

    // Parts that each pass can still add up to too much.
    const realComplete = api.deps.videos!.complete;
    const deleted: Array<string> = [];
    const realDelete = api.deps.videos!.delete;
    Object.assign(api.deps.videos!, {
      complete: async () => MAX_VIDEO_BYTES + 1,
      delete: async (key: string) => {
        deleted.push(key);
        await realDelete(key);
      },
    });
    const done = await complete(owner, file, uploadId);
    expect(done.status).toBe(413);
    expect(deleted).toEqual([`videos/${docId}/${file}`]);
    Object.assign(api.deps.videos!, { complete: realComplete, delete: realDelete });
  });

  it("refuses an unsupported type and malformed requests", async () => {
    const { api, owner, docId, start, part } = await setup();
    expect((await start(owner, { type: "text/html", size: 10 })).status).toBe(415);
    expect((await start(owner, { type: "constructor", size: 10 })).status).toBe(415);
    const { file, uploadId } = (await (await start(owner)).json()) as {
      file: string;
      uploadId: string;
    };
    for (const number of [0, MAX_VIDEO_PARTS + 1, "x", 1.5]) {
      expect((await part(owner, file, uploadId, number, MP4)).status).toBe(400);
    }
    expect((await part(owner, file, uploadId, 1, new Uint8Array())).status).toBe(400);
    expect((await part(owner, "../x.mp4", uploadId, 1, MP4)).status).toBe(404);
    expect((await part(owner, file, "someone-elses", 1, MP4)).status).toBe(404);

    const finish = (body: unknown) =>
      api.call("POST", `/api/docs/${docId}/videos/${file}`, { body, headers: { Cookie: owner } });
    expect((await finish({ parts: [] })).status).toBe(400);
    expect((await finish({ uploadId, parts: [] })).status).toBe(400);
    expect((await finish({ uploadId, parts: [{ partNumber: 2, etag: "x" }] })).status).toBe(400);
    expect((await finish({ uploadId: "gone", parts: [{ partNumber: 1, etag: "x" }] })).status).toBe(
      404,
    );
  });

  it("gives upload routes to editors only", async () => {
    const { api, owner, docId, person, start, part, complete } = await setup();
    const { file, uploadId } = (await (await start(owner)).json()) as {
      file: string;
      uploadId: string;
    };
    for (const [email, role] of [
      ["v@example.com", "viewer"],
      ["c@example.com", "commenter"],
    ] as const) {
      const cookie = await person(email, role);
      expect((await start(cookie)).status).toBe(403);
      expect((await part(cookie, file, uploadId, 1, MP4)).status).toBe(403);
      expect((await complete(cookie, file, uploadId)).status).toBe(403);
      const abort = await api.call(
        "DELETE",
        `/api/docs/${docId}/videos/${file}?uploadId=${uploadId}`,
        { headers: { Cookie: cookie } },
      );
      expect(abort.status).toBe(403);
    }
    expect(api.uploads.size).toBe(1);
  });

  it("refuses a cross-site part with the session cookie", async () => {
    const { owner, start, part } = await setup();
    const { file, uploadId } = (await (await start(owner)).json()) as {
      file: string;
      uploadId: string;
    };
    const response = await part(owner, file, uploadId, 1, MP4, "https://evil.test");
    expect(response.status).toBe(403);
  });

  it("keeps readers without access out of a video", async () => {
    const { api, owner, upload } = await setup();
    const { response } = await upload(owner, [MP4]);
    const { url } = (await response.json()) as { url: string };
    const other = (await (
      await api.call("POST", "/api/docs", { body: { title: "Other" }, headers: { Cookie: owner } })
    ).json()) as DocWithTabs;
    await api.call("POST", `/api/docs/${other.doc.id}/members`, {
      body: { email: "s@example.com", role: "editor" },
      headers: { Cookie: owner },
    });
    const stranger = await api.signIn("s@example.com");
    expect((await api.call("GET", url, { headers: { Cookie: stranger } })).status).toBe(404);
    expect((await api.call("HEAD", url, { headers: { Cookie: stranger } })).status).toBe(404);
    expect((await api.call("GET", url)).status).toBe(401);
  });

  it("does not serve names it never issued", async () => {
    const { api, owner, docId } = await setup();
    for (const file of ["x.mp4", "00000000-0000-4000-8000-000000000000.html"]) {
      const response = await api.call("GET", `/api/videos/${docId}/${file}`, {
        headers: { Cookie: owner },
      });
      expect(response.status).toBe(404);
    }
  });

  it("removes videos with the doc", async () => {
    const { api, owner, docId, upload } = await setup();
    await upload(owner, [MP4]);
    expect(api.videos.size).toBe(1);
    const response = await api.call("DELETE", `/api/docs/${docId}`, { headers: { Cookie: owner } });
    expect(response.status).toBe(200);
    expect(api.videos.size).toBe(0);
  });

  it("answers video_storage_unavailable without R2, for editors only", async () => {
    const { api, owner, docId, person, start } = await setup({ videos: null });
    const refused = await start(owner);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "video_storage_unavailable" });
    expect((await start(await person("v@example.com", "viewer"))).status).toBe(403);
    const served = await api.call(
      "GET",
      `/api/videos/${docId}/00000000-0000-4000-8000-000000000000.mp4`,
      { headers: { Cookie: owner } },
    );
    expect(served.status).toBe(404);
    expect(
      (await api.call("DELETE", `/api/docs/${docId}`, { headers: { Cookie: owner } })).status,
    ).toBe(200);
  });
});

describe("video serving", () => {
  async function stored() {
    const context = await setup();
    const { response } = await context.upload(context.owner, [MP4]);
    const { url } = (await response.json()) as { url: string };
    const get = (range?: string, method = "GET") =>
      context.api.call(method, url, {
        headers: { Cookie: context.owner, ...(range ? { Range: range } : {}) },
      });
    return { ...context, url, get };
  }

  it("answers ranges with 206 and the right bytes", async () => {
    const { get } = await stored();
    const middle = await get("bytes=4-7");
    expect(middle.status).toBe(206);
    expect(middle.headers.get("Content-Range")).toBe(`bytes 4-7/${MP4.length}`);
    expect(middle.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await middle.arrayBuffer())).toEqual(MP4.subarray(4, 8));

    const open = await get("bytes=12-");
    expect(open.headers.get("Content-Range")).toBe(`bytes 12-15/${MP4.length}`);
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(MP4.subarray(12));

    const tail = await get("bytes=-2");
    expect(tail.headers.get("Content-Range")).toBe(`bytes 14-15/${MP4.length}`);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(MP4.subarray(14));
  });

  it("answers 416 past the end, and the whole file for a range it does not handle", async () => {
    const { get } = await stored();
    const past = await get(`bytes=${MP4.length}-`);
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe(`bytes */${MP4.length}`);
    expect((await get("bytes=0-1,3-4")).status).toBe(200);
    expect((await get("items=0-1")).status).toBe(200);
  });

  it("answers HEAD with the size and no body", async () => {
    const { get } = await stored();
    const head = await get(undefined, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(MP4.length));
    expect(head.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });
});

describe("parseRange", () => {
  it.each([
    [null, null],
    ["bytes=-", null],
    ["bytes=5-2", null],
    ["bytes=0-0", { offset: 0, length: 1 }],
    ["bytes=0-999", { offset: 0, length: 10 }],
    ["bytes=-999", { offset: 0, length: 10 }],
    ["bytes=-0", "unsatisfiable"],
    ["bytes=10-", "unsatisfiable"],
  ])("reads %s", (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected);
  });
});

describe("r2VideoStore", () => {
  function fakeBucket() {
    const calls: Array<unknown> = [];
    const objects = new Map<string, number>([
      ["videos/d1/a.mp4", 5],
      ["videos/d2/a.mp4", 5],
    ]);
    const upload = {
      uploadId: "u1",
      uploadPart: async (partNumber: number) => {
        if (partNumber === 9) {
          throw new Error("uploadPart: The specified multipart upload does not exist. (10024)");
        }
        if (partNumber === 8) throw new Error("uploadPart: We encountered an internal error.");
        return { partNumber, etag: `e${partNumber}` };
      },
      complete: async (parts: unknown) => {
        calls.push(["complete", parts]);
        return { size: 5 };
      },
      abort: async () => {
        calls.push(["abort"]);
      },
    };
    const bucket = {
      createMultipartUpload: async (key: string, options: unknown) => {
        calls.push(["create", key, options]);
        return upload;
      },
      resumeMultipartUpload: () => upload,
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key) } : null),
      get: async (key: string, options: unknown) => {
        calls.push(["get", key, options]);
        return objects.has(key) ? { body: "stream" } : null;
      },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (keys: string | Array<string>) => {
        for (const key of [keys].flat()) objects.delete(key);
      },
    };
    return { calls, objects, store: r2VideoStore(bucket as unknown as R2Bucket) };
  }

  const body = new Response("x").body!;

  it("passes the multipart calls through the bucket", async () => {
    const { calls, store } = fakeBucket();
    expect(await store.create("k", "video/mp4")).toBe("u1");
    expect(calls[0]).toEqual(["create", "k", { httpMetadata: { contentType: "video/mp4" } }]);
    expect(await store.uploadPart("k", "u1", 1, body)).toBe("e1");
    expect(await store.complete("k", "u1", [{ partNumber: 1, etag: "e1" }])).toBe(5);
    await store.abort("k", "u1");
    expect(calls.at(-1)).toEqual(["abort"]);
  });

  it("reads a missing upload as null and lets other failures through", async () => {
    const { store } = fakeBucket();
    expect(await store.uploadPart("k", "u1", 9, body)).toBeNull();
    await expect(store.uploadPart("k", "u1", 8, body)).rejects.toThrow("internal error");
  });

  it("reads, ranges and deletes by prefix", async () => {
    const { calls, objects, store } = fakeBucket();
    expect(await store.head("videos/d1/a.mp4")).toEqual({ size: 5 });
    expect(await store.head("nope")).toBeNull();
    await store.get("videos/d1/a.mp4", { offset: 1, length: 2 });
    expect(calls.at(-1)).toEqual(["get", "videos/d1/a.mp4", { range: { offset: 1, length: 2 } }]);
    await store.deletePrefix("videos/d1/");
    expect([...objects.keys()]).toEqual(["videos/d2/a.mp4"]);
  });
});
