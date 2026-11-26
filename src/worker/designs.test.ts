import { describe, expect, it } from "vitest";

import {
  DESIGN_VERSIONS_KEPT,
  MAX_DESIGN_FIG_BYTES,
  type DesignListItem,
  type DesignSaveResult,
  type DesignView,
} from "../shared/design.ts";
import { handleApi } from "./api.ts";
import { ORIGIN, makeApiHarness } from "./testing/apiHarness.ts";

/** A tiny stand-in .fig: the zip container's magic, then bytes that mark the save. */
const fig = (mark: string) =>
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(mark)]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie } });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Binary bodies.
    }
    return { status: response.status, headers: response.headers, body: parsed as A };
  };
  /** One save: the .fig bytes then the PNG bytes in one octet-stream body. */
  const save = async (
    cookie: string,
    designId: string,
    input: {
      baseVersion: number;
      fig: Uint8Array;
      png?: Uint8Array | null;
      origin?: string;
      type?: string;
    },
  ) => {
    const png = input.png === undefined ? PNG : input.png;
    const body = new Uint8Array([...input.fig, ...(png ?? [])]);
    const request = new Request(
      `${ORIGIN}/api/designs/${designId}/versions?baseVersion=${input.baseVersion}&figBytes=${input.fig.length}`,
      {
        method: "POST",
        headers: {
          Origin: input.origin ?? ORIGIN,
          Cookie: cookie,
          "Content-Type": input.type ?? "application/octet-stream",
        },
        body,
      },
    );
    const response = await handleApi(request, api.deps);
    return {
      status: response.status,
      body: (await response.json()) as DesignSaveResult & { error?: string; design: DesignView },
    };
  };
  const create = async (cookie: string, body: Record<string, unknown> = {}) =>
    (await send<{ design: DesignView }>(cookie, "POST", "/api/designs", body)).body.design;
  /** Puts someone on the design with a role (an invite they claim on sign-in). */
  const member = async (designId: string, email: string, role: string) => {
    await api.db
      .prepare(
        `INSERT INTO design_members (id, design_id, user_id, email, role, added_by, created_at)
         VALUES (?, ?, NULL, ?, ?, NULL, 1)`,
      )
      .bind(crypto.randomUUID(), designId, email, role)
      .run();
    return api.signIn(email);
  };
  const objectKeys = () =>
    [...api.images.keys()].filter((key) => key.startsWith("designs/")).sort();
  return { api, admin, send, save, create, member, objectKeys };
}

describe("designs API", () => {
  it("creates an empty design, saves versions and serves the file and picture", async () => {
    const { api, admin, send, save, create } = await setup();
    const design = await create(admin, { title: "Landing" });
    expect(design).toMatchObject({
      title: "Landing",
      version: 0,
      pictureVersion: null,
      role: "owner",
    });
    expect(design.editor).toEqual({ origin: null });
    expect(
      (await send<{ error: string }>(admin, "GET", `/api/designs/${design.id}/fig`)).body,
    ).toEqual({
      error: "no_file",
    });

    const first = await save(admin, design.id, { baseVersion: 0, fig: fig("one") });
    expect(first.status).toBe(201);
    expect(first.body.design).toMatchObject({ version: 1, pictureVersion: 1, figBytes: 7 });

    const file = await send<string>(admin, "GET", `/api/designs/${design.id}/fig`);
    expect(file.status).toBe(200);
    expect(file.headers.get("X-Design-Version")).toBe("1");
    expect(file.body).toContain("one");

    const picture = await send<string>(admin, "GET", `/api/designs/${design.id}/picture/1`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("Content-Type")).toBe("image/png");
    // Revalidated every load (access can change), and cheap when the browser has it.
    expect(picture.headers.get("Cache-Control")).toBe("private, no-cache");
    const again = await api.call("GET", `/api/designs/${design.id}/picture/1`, {
      headers: { Cookie: admin, "If-None-Match": picture.headers.get("ETag")! },
    });
    expect(again.status).toBe(304);

    // A save with no picture keeps the older one.
    const second = await save(admin, design.id, { baseVersion: 1, fig: fig("two"), png: null });
    expect(second.body.design).toMatchObject({ version: 2, pictureVersion: 1 });
    // A malformed picture is dropped, not fatal.
    const third = await save(admin, design.id, {
      baseVersion: 2,
      fig: fig("three"),
      png: new Uint8Array([1, 2, 3]),
    });
    expect(third.status).toBe(201);
    expect(third.body).toMatchObject({
      pictureSkipped: "invalid",
      design: { version: 3, pictureVersion: 1 },
    });
  });

  it("refuses a save made from an older version", async () => {
    const { admin, save, create, objectKeys } = await setup();
    const design = await create(admin);
    expect((await save(admin, design.id, { baseVersion: 0, fig: fig("a") })).status).toBe(201);
    const before = objectKeys();
    const stale = await save(admin, design.id, { baseVersion: 0, fig: fig("b") });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("version_conflict");
    expect(stale.body.design.version).toBe(1);
    // Nothing of the refused save is left behind.
    expect(objectKeys()).toEqual(before);
  });

  it("keeps the last versions and the one its picture came from, and deletes older ones", async () => {
    const { api, admin, send, save, create, objectKeys } = await setup();
    const design = await create(admin);
    // Version 1 has a picture; the rest do not, so cards keep showing version 1's.
    await save(admin, design.id, { baseVersion: 0, fig: fig("v1") });
    const total = DESIGN_VERSIONS_KEPT + 5;
    for (let version = 2; version <= total; version += 1) {
      const saved = await save(admin, design.id, {
        baseVersion: version - 1,
        fig: fig(`v${version}`),
        png: null,
      });
      expect(saved.status).toBe(201);
    }
    const { results } = await api.db
      .prepare("SELECT version FROM design_versions WHERE design_id = ? ORDER BY version")
      .bind(design.id)
      .all<{ version: number }>();
    const kept = results.map((row) => row.version);
    expect(kept).toEqual([
      1,
      ...Array.from(
        { length: DESIGN_VERSIONS_KEPT },
        (_, i) => total - DESIGN_VERSIONS_KEPT + 1 + i,
      ),
    ]);
    // One .fig per kept version plus version 1's picture.
    expect(objectKeys()).toHaveLength(kept.length + 1);
    expect(objectKeys().some((key) => key.startsWith(`designs/${design.id}/2-`))).toBe(false);
    expect((await send(admin, "GET", `/api/designs/${design.id}/fig?version=2`)).status).toBe(404);
    expect(
      (await send(admin, "GET", `/api/designs/${design.id}/fig?version=${total}`)).status,
    ).toBe(200);
    expect((await send(admin, "GET", `/api/designs/${design.id}/picture/1`)).status).toBe(200);
  });

  it("leaves no object behind when storing a save fails, and keeps a stored save when cleanup fails", async () => {
    const { api, admin, save, create, objectKeys } = await setup();
    const design = await create(admin);
    const store = api.deps.images;
    const deps = api.deps as { images: typeof store };
    // The picture upload fails after the .fig is stored.
    deps.images = {
      ...store,
      put: async (key, body, type) => {
        if (key.endsWith(".png")) throw new Error("R2 down");
        await store.put(key, body, type);
      },
    };
    await expect(save(admin, design.id, { baseVersion: 0, fig: fig("a") })).rejects.toThrow(
      "R2 down",
    );
    expect(objectKeys()).toEqual([]);

    // Deleting old versions fails: the save still succeeds, and the rows stay for a later retry.
    deps.images = { ...store, delete: async () => Promise.reject(new Error("R2 down")) };
    for (let version = 1; version <= DESIGN_VERSIONS_KEPT + 1; version += 1) {
      const saved = await save(admin, design.id, {
        baseVersion: version - 1,
        fig: fig(`v${version}`),
        png: null,
      });
      expect(saved.status).toBe(201);
    }
    const count = async () =>
      (await api.db
        .prepare("SELECT count(*) AS n FROM design_versions WHERE design_id = ?")
        .bind(design.id)
        .first<{ n: number }>())!.n;
    expect(await count()).toBe(DESIGN_VERSIONS_KEPT + 1);
    deps.images = store;
    await save(admin, design.id, {
      baseVersion: DESIGN_VERSIONS_KEPT + 1,
      fig: fig("next"),
      png: null,
    });
    expect(await count()).toBe(DESIGN_VERSIONS_KEPT);
    expect(objectKeys()).toHaveLength(DESIGN_VERSIONS_KEPT);
  });

  it("does not answer 304 for a pruned version's picture", async () => {
    const { api, admin, save, create } = await setup();
    const design = await create(admin);
    await save(admin, design.id, { baseVersion: 0, fig: fig("v1") });
    await save(admin, design.id, { baseVersion: 1, fig: fig("v2") });
    for (let version = 3; version <= DESIGN_VERSIONS_KEPT + 1; version += 1) {
      await save(admin, design.id, {
        baseVersion: version - 1,
        fig: fig(`v${version}`),
        png: null,
      });
    }
    const cached = await api.call("GET", `/api/designs/${design.id}/picture/1`, {
      headers: { Cookie: admin, "If-None-Match": `"${design.id}-1"` },
    });
    expect(cached.status).toBe(404);
    // Its row left behind with the object gone (a cleanup that stopped half way): still 404.
    const latest = `designs/${design.id}/2-`;
    const key = [...api.images.keys()].find(
      (each) => each.startsWith(latest) && each.endsWith(".png"),
    )!;
    api.images.delete(key);
    const half = await api.call("GET", `/api/designs/${design.id}/picture/2`, {
      headers: { Cookie: admin, "If-None-Match": `"${design.id}-2"` },
    });
    expect(half.status).toBe(404);
  });

  it("refuses files that are too large or not .fig, with a clear error", async () => {
    const { admin, save, create } = await setup();
    const design = await create(admin);
    const big = await save(admin, design.id, {
      baseVersion: 0,
      fig: new Uint8Array(MAX_DESIGN_FIG_BYTES + 1),
      png: null,
    });
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ error: "design_too_large" });
    expect((big.body as unknown as { message: string }).message).toContain("20 MB");
    const notFig = await save(admin, design.id, {
      baseVersion: 0,
      fig: new TextEncoder().encode("<html>"),
    });
    expect(notFig.status).toBe(400);
    expect(notFig.body.error).toBe("invalid_design");
  });

  it("takes saves only from the app's origin, as raw bytes", async () => {
    const { admin, save, create } = await setup();
    const design = await create(admin);
    const crossSite = await save(admin, design.id, {
      baseVersion: 0,
      fig: fig("x"),
      origin: "https://designer.test",
    });
    expect(crossSite.status).toBe(403);
    const form = await save(admin, design.id, {
      baseVersion: 0,
      fig: fig("x"),
      type: "text/plain",
    });
    expect(form.status).toBe(403);
  });

  it("checks access: strangers see nothing, viewers cannot save, editors rename, owners move and delete", async () => {
    const { api, admin, send, save, create, member } = await setup();
    const { project } = (
      await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
    ).body;
    const design = await create(admin, { title: "Hero", projectId: project.id });
    await save(admin, design.id, { baseVersion: 0, fig: fig("a") });

    const viewer = await member(design.id, "viewer@example.com", "viewer");
    const editor = await member(design.id, "editor@example.com", "editor");
    // A stranger: on another design only.
    const other = await create(admin, { title: "Other" });
    const stranger = await member(other.id, "stranger@example.com", "owner");

    expect((await send(stranger, "GET", `/api/designs/${design.id}`)).status).toBe(404);
    expect((await send(stranger, "GET", `/api/designs/${design.id}/fig`)).status).toBe(404);
    expect((await send(stranger, "GET", `/api/designs/${design.id}/picture/1`)).status).toBe(404);
    const strangerList = await send<{ designs: Array<DesignListItem> }>(
      stranger,
      "GET",
      "/api/designs",
    );
    expect(strangerList.body.designs.map((each) => each.title)).toEqual(["Other"]);

    expect(
      (await send<{ design: DesignView }>(viewer, "GET", `/api/designs/${design.id}`)).body.design,
    ).toMatchObject({ role: "viewer", canEdit: false });
    expect((await save(viewer, design.id, { baseVersion: 1, fig: fig("b") })).status).toBe(403);
    expect((await send(viewer, "PATCH", `/api/designs/${design.id}`, { title: "No" })).status).toBe(
      403,
    );

    expect((await save(editor, design.id, { baseVersion: 1, fig: fig("b") })).status).toBe(201);
    expect(
      (
        await send<{ design: DesignView }>(editor, "PATCH", `/api/designs/${design.id}`, {
          title: "Hero 2",
        })
      ).body.design.title,
    ).toBe("Hero 2");
    expect(
      (await send(editor, "PATCH", `/api/designs/${design.id}`, { projectId: null })).status,
    ).toBe(403);
    expect((await send(editor, "DELETE", `/api/designs/${design.id}`)).status).toBe(403);

    const moved = await send<{ design: DesignView }>(admin, "PATCH", `/api/designs/${design.id}`, {
      projectId: null,
    });
    expect(moved.body.design.projectId).toBeNull();
    const none = await send<{ designs: Array<DesignListItem> }>(
      admin,
      "GET",
      "/api/designs?projectId=none",
    );
    expect(none.body.designs.map((each) => each.id).sort()).toEqual([design.id, other.id].sort());
    void api;
  });

  it("filters the list to yours or shared", async () => {
    const { admin, send, create, member } = await setup();
    const mine = await create(admin, { title: "Admin's" });
    const shared = await create(admin, { title: "Shared" });
    const person = await member(shared.id, "person@example.com", "editor");
    const theirs = await create(person, { title: "Person's" });
    const list = async (filter: string) =>
      (
        await send<{ designs: Array<DesignListItem> }>(
          person,
          "GET",
          `/api/designs?filter=${filter}`,
        )
      ).body.designs.map((each) => each.title);
    expect(await list("yours")).toEqual(["Person's"]);
    expect(await list("shared")).toEqual(["Shared"]);
    expect((await list("all")).sort()).toEqual(["Person's", "Shared"]);
    expect((await send(person, "GET", "/api/designs?filter=bogus")).status).toBe(400);
    void mine;
    void theirs;
  });

  it("deletes a design with every version's objects", async () => {
    const { admin, send, save, create, objectKeys } = await setup();
    const design = await create(admin);
    const keep = await create(admin);
    await save(admin, design.id, { baseVersion: 0, fig: fig("a") });
    await save(admin, design.id, { baseVersion: 1, fig: fig("b") });
    await save(admin, keep.id, { baseVersion: 0, fig: fig("c") });
    expect(objectKeys().filter((key) => key.includes(design.id))).toHaveLength(4);
    expect((await send(admin, "DELETE", `/api/designs/${design.id}`)).status).toBe(200);
    expect(objectKeys().filter((key) => key.includes(design.id))).toEqual([]);
    expect(objectKeys().filter((key) => key.includes(keep.id))).toHaveLength(2);
    expect((await send(admin, "GET", `/api/designs/${design.id}`)).status).toBe(404);
  });

  it("names the editor's own origin when one is configured", async () => {
    const api = makeApiHarness({ designerOrigin: "https://design.docs.test" });
    const admin = await api.signIn();
    const response = await api.call("POST", "/api/designs", {
      body: {},
      headers: { Cookie: admin },
    });
    expect(((await response.json()) as { design: DesignView }).design.editor).toEqual({
      origin: "https://design.docs.test",
    });
  });
});
