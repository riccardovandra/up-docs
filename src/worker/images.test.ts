import { describe, expect, it } from "vitest";

import type { DocRole } from "../shared/access.ts";
import { isDocImageSrc, MAX_IMAGE_BYTES } from "../shared/images.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { handleApi } from "./api.ts";
import { D1_CHUNK_BYTES, d1ImageStore, docImagesPrefix, imageKey, r2ImageStore } from "./images.ts";
import { makeApiHarness, ORIGIN } from "./testing/apiHarness.ts";
import { makeTestD1 } from "./testing/sqliteD1.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function setup() {
  const api = makeApiHarness();
  const owner = await api.signIn();
  const { project } = (await (
    await api.call("POST", "/api/projects", {
      body: { name: "P" },
      headers: { Cookie: owner },
    })
  ).json()) as { project: { id: string } };
  const created = (await (
    await api.call("POST", "/api/docs", {
      body: { projectId: project.id, title: "Plan" },
      headers: { Cookie: owner },
    })
  ).json()) as DocWithTabs;
  const docId = created.doc.id;
  const person = async (email: string, role: DocRole) => {
    await api.call("POST", `/api/docs/${docId}/members`, {
      body: { email, role },
      headers: { Cookie: owner },
    });
    return api.signIn(email);
  };
  const upload = (
    cookie: string,
    body: BodyInit,
    headers: Record<string, string> = { "Content-Type": "image/png" },
  ) =>
    handleApi(
      new Request(`${ORIGIN}/api/docs/${docId}/images`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie, ...headers },
        body,
      }),
      api.deps,
    );
  return { api, owner, projectId: project.id, docId, person, upload };
}

describe("image routes", () => {
  it("stores an editor's upload and serves it to anyone who can read the doc", async () => {
    const { api, owner, docId, person, upload } = await setup();
    const editor = await person("e@example.com", "editor");
    const response = await upload(editor, PNG);
    expect(response.status).toBe(201);
    const { url } = (await response.json()) as { url: string };
    expect(isDocImageSrc(url)).toBe(true);
    expect(url.startsWith(`/api/images/${docId}/`)).toBe(true);
    expect([...api.images.keys()]).toEqual([url.replace("/api/", "")]);

    const viewer = await person("v@example.com", "viewer");
    for (const cookie of [owner, viewer]) {
      const served = await api.call("GET", url, {
        headers: { Cookie: cookie },
      });
      expect(served.status).toBe(200);
      expect(served.headers.get("Content-Type")).toBe("image/png");
      expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    }
  });

  it("refuses uploads from commenters and viewers, and reads by non-members", async () => {
    const { api, owner, projectId, upload, person } = await setup();
    expect((await upload(await person("v@example.com", "viewer"), PNG)).status).toBe(403);
    expect((await upload(await person("c@example.com", "commenter"), PNG)).status).toBe(403);
    const { url } = (await (await upload(owner, PNG)).json()) as {
      url: string;
    };

    // Signed in through another doc, with no access to this one.
    const elsewhere = (await (
      await api.call("POST", "/api/docs", {
        body: { projectId, title: "Other" },
        headers: { Cookie: owner },
      })
    ).json()) as DocWithTabs;
    await api.call("POST", `/api/docs/${elsewhere.doc.id}/members`, {
      body: { email: "s@example.com", role: "editor" },
      headers: { Cookie: owner },
    });
    const stranger = await api.signIn("s@example.com");
    expect((await api.call("GET", url, { headers: { Cookie: stranger } })).status).toBe(404);
    expect((await api.call("GET", url)).status).toBe(401);
  });

  it("checks type, content and size", async () => {
    const { api, owner, upload } = await setup();
    const { token } = (await (
      await api.call("POST", "/api/tokens", {
        body: { name: "agent" },
        headers: { Cookie: owner },
      })
    ).json()) as { token: string };
    const bearer = (type: string, body: BodyInit) =>
      upload("", body, {
        "Content-Type": type,
        Authorization: `Bearer ${token}`,
      });
    expect((await bearer("image/svg+xml", "<svg/>")).status).toBe(415);
    expect((await bearer("text/html", "<html>")).status).toBe(415);
    // A session may only POST JSON or an allowed image type.
    expect((await upload(owner, "<svg/>", { "Content-Type": "image/svg+xml" })).status).toBe(403);
    expect((await upload(owner, "<html><script>")).status).toBe(400);
    expect((await upload(owner, new Uint8Array())).status).toBe(400);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    expect((await upload(owner, big)).status).toBe(413);
    expect((await upload(owner, "GIF89a......", { "Content-Type": "image/gif" })).status).toBe(201);
  });

  it("refuses a cross-site upload with the session cookie", async () => {
    const { api, owner, docId } = await setup();
    const response = await handleApi(
      new Request(`${ORIGIN}/api/docs/${docId}/images`, {
        method: "POST",
        headers: {
          Origin: "https://evil.test",
          Cookie: owner,
          "Content-Type": "image/png",
        },
        body: PNG,
      }),
      api.deps,
    );
    expect(response.status).toBe(403);
  });

  it("does not serve names it never issued", async () => {
    const { api, owner, docId } = await setup();
    for (const file of ["../secret", "x.png", "00000000-0000-0000-0000-000000000000.svg"]) {
      const response = await api.call("GET", `/api/images/${docId}/${file}`, {
        headers: { Cookie: owner },
      });
      expect(response.status).toBe(404);
    }
  });
});

describe("d1ImageStore", () => {
  const FILE = "00000000-0000-4000-8000-000000000000.png";

  async function store() {
    const db = makeTestD1();
    await db.batch([
      db.prepare("INSERT INTO projects (id, name, key, created_at) VALUES ('p', 'P', 'p', 1)"),
      ...["d1", "d2"].map((id) =>
        db
          .prepare(
            "INSERT INTO docs (id, project_id, title, created_at, updated_at) VALUES (?1, 'p', ?1, 1, 1)",
          )
          .bind(id),
      ),
    ]);
    const rows = async (docId: string) =>
      (
        await db
          .prepare("SELECT count(*) AS n FROM image_chunks WHERE doc_id = ?1")
          .bind(docId)
          .first<{ n: number }>()
      )?.n;
    return { db, images: d1ImageStore(db), rows };
  }

  // Bytes that differ at every offset a misplaced chunk would land on.
  const bytes = (size: number) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >> 8) * 7 + (i >> 16)) & 0xff;
    return out;
  };

  it.each([
    ["one byte", 1, 1],
    ["a small image", 2048, 1],
    ["one under a chunk", D1_CHUNK_BYTES - 1, 1],
    ["exactly one chunk", D1_CHUNK_BYTES, 1],
    ["one over a chunk", D1_CHUNK_BYTES + 1, 2],
    ["exactly two chunks", D1_CHUNK_BYTES * 2, 2],
    ["the 10 MB limit", MAX_IMAGE_BYTES, 8],
  ])("round trips %s with exact bytes", async (_, size, chunks) => {
    const { images, rows } = await store();
    const original = bytes(size);
    await images.put(imageKey("d1", FILE), original.buffer, "image/png");
    expect(await rows("d1")).toBe(chunks);
    const object = await images.get(imageKey("d1", FILE));
    expect(Buffer.compare(new Uint8Array(object!.body as ArrayBuffer), original)).toBe(0);
  });

  it("keeps every row under D1's 2,000,000 byte limit", async () => {
    const { db, images } = await store();
    await images.put(imageKey("d1", FILE), bytes(MAX_IMAGE_BYTES).buffer, "image/png");
    const largest = await db
      .prepare("SELECT max(length(doc_id) + length(file) + length(data)) AS n FROM image_chunks")
      .first<{ n: number }>();
    expect(largest!.n).toBeLessThan(1_900_000);
  });

  it("returns null for a key it does not hold", async () => {
    const { images } = await store();
    expect(await images.get(imageKey("d1", FILE))).toBeNull();
  });

  it.each([
    ["first", 0],
    ["middle", 1],
    ["last", 2],
  ])("returns null when the %s chunk is missing", async (_, seq) => {
    const { db, images } = await store();
    await images.put(imageKey("d1", FILE), bytes(D1_CHUNK_BYTES * 3).buffer, "image/png");
    await db.prepare("DELETE FROM image_chunks WHERE seq = ?1").bind(seq).run();
    expect(await images.get(imageKey("d1", FILE))).toBeNull();
  });

  it("stores nothing when a chunk fails to write", async () => {
    const { db, images, rows } = await store();
    await db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON image_chunks WHEN NEW.seq = 1
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    await expect(
      images.put(imageKey("d1", FILE), bytes(D1_CHUNK_BYTES * 2).buffer, "image/png"),
    ).rejects.toThrow("disk full");
    expect(await rows("d1")).toBe(0);
  });

  it("replaces a key without keeping chunks of the longer image", async () => {
    const { images, rows } = await store();
    await images.put(imageKey("d1", FILE), bytes(D1_CHUNK_BYTES * 3).buffer, "image/png");
    await images.put(imageKey("d1", FILE), bytes(10).buffer, "image/png");
    expect(await rows("d1")).toBe(1);
    const object = await images.get(imageKey("d1", FILE));
    expect((object!.body as ArrayBuffer).byteLength).toBe(10);
  });

  it("deletes one doc's images and leaves other docs alone", async () => {
    const { images, rows } = await store();
    await images.put(imageKey("d1", FILE), bytes(D1_CHUNK_BYTES + 1).buffer, "image/png");
    await images.put(imageKey("d2", FILE), bytes(10).buffer, "image/png");
    await images.deletePrefix(docImagesPrefix("d1"));
    expect(await rows("d1")).toBe(0);
    expect(await images.get(imageKey("d1", FILE))).toBeNull();
    expect(await images.get(imageKey("d2", FILE))).not.toBeNull();
  });

  it("drops image rows with the doc, and with the doc's project", async () => {
    const { db, images, rows } = await store();
    await images.put(imageKey("d1", FILE), bytes(10).buffer, "image/png");
    await images.put(imageKey("d2", FILE), bytes(10).buffer, "image/png");
    await db.prepare("DELETE FROM docs WHERE id = 'd1'").run();
    expect(await rows("d1")).toBe(0);
    await db.prepare("DELETE FROM projects WHERE id = 'p'").run();
    expect(await rows("d2")).toBe(0);
  });
});

describe("r2ImageStore", () => {
  it("passes images through the bucket", async () => {
    const objects = new Map<string, ArrayBuffer>();
    const puts: Array<unknown> = [];
    const bucket = {
      put: async (key: string, body: ArrayBuffer, options: unknown) => {
        objects.set(key, body);
        puts.push(options);
      },
      get: async (key: string) => {
        const body = objects.get(key);
        return body ? { body } : null;
      },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (keys: Array<string>) => {
        for (const key of keys) objects.delete(key);
      },
    };
    const images = r2ImageStore(bucket as unknown as R2Bucket);
    const body = PNG.slice().buffer;
    await images.put("images/d1/a.png", body, "image/png");
    await images.put("images/d2/a.png", body, "image/png");
    expect(puts[0]).toEqual({ httpMetadata: { contentType: "image/png" } });
    expect((await images.get("images/d1/a.png"))?.body).toBe(body);
    expect(await images.get("images/d1/b.png")).toBeNull();
    await images.deletePrefix("images/d1/");
    expect([...objects.keys()]).toEqual(["images/d2/a.png"]);
  });
});
