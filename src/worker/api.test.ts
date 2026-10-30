import { describe, expect, it } from "vitest";

import type {
  DocSummary,
  DocThreadLink,
  DocWithTabs,
  Library,
  LibraryProject,
  Tab,
} from "../shared/protocol.ts";
import * as Docs from "./docs.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

async function seedDoc(api: ReturnType<typeof makeApiHarness>, cookie: string) {
  const projectResponse = await api.call("POST", "/api/projects", {
    body: { name: "Acme" },
    headers: { Cookie: cookie },
  });
  const { project } = (await projectResponse.json()) as { project: { id: string } };
  const docResponse = await api.call("POST", "/api/docs", {
    body: { projectId: project.id, title: "Plan" },
    headers: { Cookie: cookie },
  });
  return (await docResponse.json()) as DocWithTabs;
}

describe("API permissions", () => {
  it("rejects requests without a session or token", async () => {
    const api = makeApiHarness();
    expect((await api.call("GET", "/api/library")).status).toBe(401);
    const forged = await api.call("GET", "/api/library", {
      headers: { Authorization: "Bearer dct_forged" },
    });
    expect(forged.status).toBe(401);
  });

  it("accepts a bearer token until it is revoked", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const created = await api.call("POST", "/api/tokens", {
      body: { name: "agent" },
      headers: { Cookie: cookie },
    });
    const { id, token } = (await created.json()) as { id: string; token: string };
    const bearer = { Authorization: `Bearer ${token}` };

    expect((await api.call("GET", "/api/library", { headers: bearer })).status).toBe(200);
    // A token is not an ambient credential, so it works from any origin.
    const project = await api.call("POST", "/api/projects", {
      body: { name: "From agent" },
      headers: { ...bearer, Origin: "https://elsewhere.test" },
    });
    expect(project.status).toBe(201);

    const listed = await api.call("GET", "/api/tokens", { headers: { Cookie: cookie } });
    expect(JSON.stringify(await listed.json())).not.toContain(token);

    await api.call("DELETE", `/api/tokens/${id}`, { headers: { Cookie: cookie } });
    expect((await api.call("GET", "/api/library", { headers: bearer })).status).toBe(401);
  });

  it("keeps token management behind a session", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const created = await api.call("POST", "/api/tokens", {
      body: { name: "agent" },
      headers: { Cookie: cookie },
    });
    const { token } = (await created.json()) as { token: string };
    const minted = await api.call("POST", "/api/tokens", {
      body: { name: "escalate" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(minted.status).toBe(403);
  });

  it("refuses cookie-authed writes from another origin or as a form post", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const crossSite = await api.call("POST", "/api/projects", {
      body: { name: "x" },
      headers: { Cookie: cookie, Origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
    const form = await api.call("POST", "/api/projects", {
      body: { name: "x" },
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(403);
    const socket = await api.call("GET", "/api/docs/any/ws", {
      headers: { Cookie: cookie, Origin: "https://evil.test", Upgrade: "websocket" },
    });
    expect(socket.status).toBe(403);
  });
});

describe("tab writes", () => {
  it("bumps the version, broadcasts, and returns 409 with the current tab on a stale base", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { tabs } = await seedDoc(api, cookie);
    const tab = tabs[0]!;
    expect(tab.version).toBe(1);

    const first = await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: { baseVersion: 1, markdown: "# Hello", clientId: "editor-a" },
      headers: { Cookie: cookie },
    });
    expect(first.status).toBe(200);
    const saved = ((await first.json()) as { tab: Tab }).tab;
    expect(saved).toMatchObject({ version: 2, markdown: "# Hello" });
    expect(api.broadcasts.at(-1)).toEqual({ type: "tab.updated", tab: saved, origin: "editor-a" });

    const stale = await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: { baseVersion: 1, markdown: "# Overwrite" },
      headers: { Cookie: cookie },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "version_conflict",
      tab: { version: 2, markdown: "# Hello" },
    });
    expect(api.broadcasts).toHaveLength(1);
  });

  it("refuses a tab write that adds an invalid diagram with 422 and its diagnostics", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { tabs } = await seedDoc(api, cookie);
    const tab = tabs[0]!;
    const response = await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: {
        baseVersion: tab.version,
        markdown: "```t3-widget id=a\nexport default () => <g/>;\n```",
      },
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: string;
      problems: Array<{ diagnostics: Array<{ rule: string }> }>;
    };
    expect(body.error).toBe("widget_invalid");
    expect(body.problems[0]?.diagnostics[0]?.rule).toBe("svg-root");
  });

  it("supports nested tabs ordered among their siblings", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc, tabs } = await seedDoc(api, cookie);
    const create = async (title: string, parentTabId?: string) => {
      const response = await api.call("POST", `/api/docs/${doc.id}/tabs`, {
        body: { title, ...(parentTabId ? { parentTabId } : {}) },
        headers: { Cookie: cookie },
      });
      return ((await response.json()) as { tab: Tab }).tab;
    };
    const second = await create("Second");
    const child = await create("Child", tabs[0]!.id);
    const sibling = await create("Child 2", tabs[0]!.id);
    expect(second).toMatchObject({ parentTabId: null, position: 1 });
    expect(child).toMatchObject({ parentTabId: tabs[0]!.id, position: 0 });
    expect(sibling.position).toBe(1);

    const loaded = await api.call("GET", `/api/docs/${doc.id}`, { headers: { Cookie: cookie } });
    expect(((await loaded.json()) as DocWithTabs).tabs).toHaveLength(4);
  });

  it("rejects a parent tab from another doc", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const first = await seedDoc(api, cookie);
    const second = await seedDoc(api, cookie);
    const response = await api.call("POST", `/api/docs/${second.doc.id}/tabs`, {
      body: { title: "Bad", parentTabId: first.tabs[0]!.id },
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("tab tree", () => {
  async function seedTree() {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc, tabs } = await seedDoc(api, cookie);
    const headers = { Cookie: cookie };
    const create = async (title: string, parentTabId?: string) => {
      const response = await api.call("POST", `/api/docs/${doc.id}/tabs`, {
        body: { title, ...(parentTabId ? { parentTabId } : {}) },
        headers,
      });
      return ((await response.json()) as { tab: Tab }).tab;
    };
    const root = tabs[0]!;
    const second = await create("Second");
    const third = await create("Third");
    const child = await create("Child", root.id);
    const grandchild = await create("Grandchild", child.id);
    const move = (tabId: string, body: Record<string, unknown>) =>
      api.call("POST", `/api/tabs/${tabId}/move`, { body, headers });
    const remove = (tabId: string) =>
      api.call("DELETE", `/api/tabs/${tabId}?clientId=editor-a`, { headers });
    const layout = async () => {
      const response = await api.call("GET", `/api/docs/${doc.id}`, { headers });
      const loaded = (await response.json()) as DocWithTabs;
      return Object.fromEntries(
        loaded.tabs.map((tab) => [tab.title, [tab.parentTabId, tab.position] as const]),
      );
    };
    return { api, headers, root, second, third, child, grandchild, move, remove, layout };
  }

  it("reorders siblings and keeps positions dense", async () => {
    const { api, root, second, third, move, layout } = await seedTree();
    const response = await move(third.id, { parentTabId: null, position: 0, clientId: "editor-a" });
    expect(response.status).toBe(200);
    expect(await layout()).toMatchObject({
      Third: [null, 0],
      Plan: [null, 1],
      Second: [null, 2],
    });
    const message = api.broadcasts.at(-1);
    expect(message).toMatchObject({ type: "tab.moved", origin: "editor-a" });
    const placements = message?.type === "tab.moved" ? message.placements : [];
    expect(placements[0]).toEqual({ tabId: third.id, parentTabId: null, position: 0 });
    expect(placements.map((placement) => placement.tabId).toSorted()).toEqual(
      [third.id, root.id, second.id].toSorted(),
    );
  });

  it("re-parents a subtree and closes the gap it left", async () => {
    const { root, second, child, move, layout } = await seedTree();
    // Child (with its grandchild) moves from Plan to the end of Second.
    expect((await move(child.id, { parentTabId: second.id, position: 99 })).status).toBe(200);
    expect(await layout()).toMatchObject({
      Child: [second.id, 0],
      Grandchild: [child.id, 0],
    });
    // Outdent Second's child to the top level between Plan and Second.
    await move(child.id, { parentTabId: null, position: 1 });
    expect(await layout()).toMatchObject({
      Plan: [null, 0],
      Child: [null, 1],
      Second: [null, 2],
      Third: [null, 3],
    });
    expect(root.parentTabId).toBeNull();
  });

  it("refuses to move a tab under itself or its descendants", async () => {
    const { api, root, grandchild, move } = await seedTree();
    const before = api.broadcasts.length;
    expect((await move(root.id, { parentTabId: grandchild.id, position: 0 })).status).toBe(400);
    expect((await move(root.id, { parentTabId: root.id, position: 0 })).status).toBe(400);
    expect((await move(root.id, { parentTabId: null, position: -1 })).status).toBe(400);
    expect(api.broadcasts).toHaveLength(before);
  });

  it("refuses a parent from another doc", async () => {
    const { api, headers, root, move } = await seedTree();
    const other = await seedDoc(api, headers.Cookie);
    expect((await move(root.id, { parentTabId: other.tabs[0]!.id, position: 0 })).status).toBe(404);
  });

  it("deletes a tab with its subtree and renumbers its siblings", async () => {
    const { api, root, child, grandchild, remove, layout } = await seedTree();
    const response = await remove(root.id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { tabIds: Array<string> }).tabIds.toSorted()).toEqual(
      [root.id, child.id, grandchild.id].toSorted(),
    );
    expect(await layout()).toEqual({ Second: [null, 0], Third: [null, 1] });
    expect(api.broadcasts.at(-1)).toMatchObject({ type: "tab.deleted", origin: "editor-a" });
  });

  it("keeps the last top-level tab", async () => {
    const { second, third, root, remove } = await seedTree();
    expect((await remove(second.id)).status).toBe(200);
    expect((await remove(third.id)).status).toBe(200);
    expect((await remove(root.id)).status).toBe(409);
  });

  it("requires a same-origin session or a token", async () => {
    const { api, headers, root, child } = await seedTree();
    expect(
      (await api.call("POST", `/api/tabs/${child.id}/move`, { body: { position: 0 } })).status,
    ).toBe(401);
    expect((await api.call("DELETE", `/api/tabs/${root.id}`)).status).toBe(401);
    const crossSite = { ...headers, Origin: "https://evil.test" };
    expect(
      (
        await api.call("POST", `/api/tabs/${child.id}/move`, {
          body: { position: 0 },
          headers: crossSite,
        })
      ).status,
    ).toBe(403);
    expect((await api.call("DELETE", `/api/tabs/${child.id}`, { headers: crossSite })).status).toBe(
      403,
    );
  });
});

describe("doc status", () => {
  it("moves through the statuses, pushes doc.updated, and shows in the library", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc } = await seedDoc(api, cookie);
    expect(doc.status).toBe("thinking");

    for (const status of ["plan", "in_progress", "done", "thinking"] as const) {
      api.clock.now += 1;
      const response = await api.call("PATCH", `/api/docs/${doc.id}`, {
        body: { status, clientId: "editor-a" },
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const { doc: updated } = (await response.json()) as { doc: DocSummary };
      expect(updated).toMatchObject({ status, updatedAt: api.clock.now });
      expect(api.broadcasts.at(-1)).toEqual({
        type: "doc.updated",
        doc: updated,
        origin: "editor-a",
      });
    }

    await api.call("PATCH", `/api/docs/${doc.id}`, {
      body: { status: "plan" },
      headers: { Cookie: cookie },
    });
    const library = await api.call("GET", "/api/library", { headers: { Cookie: cookie } });
    const { projects } = (await library.json()) as { projects: Array<LibraryProject> };
    expect(projects[0]!.docs[0]!.status).toBe("plan");
  });

  it("rejects unknown statuses and missing docs", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc } = await seedDoc(api, cookie);
    const invalid = await api.call("PATCH", `/api/docs/${doc.id}`, {
      body: { status: "shipped" },
      headers: { Cookie: cookie },
    });
    expect(invalid.status).toBe(400);
    const missing = await api.call("PATCH", "/api/docs/missing", {
      body: { status: "plan" },
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
    const crossSite = await api.call("PATCH", `/api/docs/${doc.id}`, {
      body: { status: "plan" },
      headers: { Cookie: cookie, Origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
  });
});

describe("projects", () => {
  const sync = (api: ReturnType<typeof makeApiHarness>, cookie: string, projects: unknown) =>
    api.call("POST", "/api/projects/sync", { body: { projects }, headers: { Cookie: cookie } });
  const library = async (api: ReturnType<typeof makeApiHarness>, cookie: string) =>
    (await (
      await api.call("GET", "/api/library", { headers: { Cookie: cookie } })
    ).json()) as Library;

  it("upserts by key: a repeat sync keeps ids, renames follow the latest title", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const first = await sync(api, cookie, [
      { key: "github.com/acme/app", name: "T3 Code" },
      { key: "title:Acme  Netherlands", name: "Acme Netherlands" },
    ]);
    expect(first.status).toBe(200);
    const { projects } = (await first.json()) as {
      projects: Array<{ id: string; key: string; name: string }>;
    };
    expect(projects.map(({ key, name }) => [key, name])).toEqual([
      ["github.com/acme/app", "T3 Code"],
      ["title:acme netherlands", "Acme Netherlands"],
    ]);

    // The VPS checkout of the same repository has another title.
    const again = await sync(api, cookie, [
      { key: "github.com/acme/app", name: "T3 Code + AI PM" },
      { key: "title:acme netherlands", name: "Acme Netherlands" },
    ]);
    const renamed = ((await again.json()) as { projects: typeof projects }).projects;
    expect(renamed.map((project) => project.id)).toEqual(projects.map((project) => project.id));
    expect(renamed[0]!.name).toBe("T3 Code + AI PM");
    expect((await library(api, cookie)).projects).toHaveLength(2);
  });

  it("adopts the same-titled project made by name before the repository synced", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc } = await seedDoc(api, cookie);
    const response = await sync(api, cookie, [{ key: "github.com/up/site", name: " acme " }]);
    const [synced] = ((await response.json()) as { projects: Array<{ id: string; key: string }> })
      .projects;
    expect(synced).toMatchObject({ id: doc.projectId, key: "github.com/up/site" });
    // A second repository with the same title gets its own project.
    await sync(api, cookie, [{ key: "github.com/fork/site", name: "Acme" }]);
    expect((await library(api, cookie)).projects.map((project) => project.key).toSorted()).toEqual([
      "github.com/fork/site",
      "github.com/up/site",
    ]);
  });

  it("creating a project by name or key returns the existing one", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const create = async (body: unknown) =>
      (
        (await (
          await api.call("POST", "/api/projects", { body, headers: { Cookie: cookie } })
        ).json()) as {
          project: { id: string; key: string; name: string };
        }
      ).project;
    const byName = await create({ name: "Client  Work" });
    expect(byName.key).toBe("title:client work");
    expect((await create({ name: "client work" })).id).toBe(byName.id);
    const byKey = await create({ name: "Site", key: "github.com/up/site" });
    expect(await create({ name: "Other name", key: "github.com/up/site" })).toEqual(byKey);
    expect(
      (
        await api.call("POST", "/api/projects", {
          body: { name: "x", key: " " },
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(400);
  });

  it("rejects malformed sync payloads", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    expect((await sync(api, cookie, "nope")).status).toBe(400);
    expect((await sync(api, cookie, [{ key: "", name: "x" }])).status).toBe(400);
    expect((await sync(api, cookie, [{ key: "k", name: "" }])).status).toBe(400);
    expect((await sync(api, cookie, [])).status).toBe(200);
  });

  it("files docs in no project and moves docs between projects", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const created = await api.call("POST", "/api/docs", {
      body: { title: "Loose", projectId: null },
      headers: { Cookie: cookie },
    });
    expect(created.status).toBe(201);
    const loose = ((await created.json()) as DocWithTabs).doc;
    expect(loose.projectId).toBeNull();
    expect((await library(api, cookie)).noProjectDocs.map((doc) => doc.id)).toEqual([loose.id]);

    const { doc } = await seedDoc(api, cookie);
    const moved = await api.call("PATCH", `/api/docs/${loose.id}`, {
      body: { projectId: doc.projectId, clientId: "editor-a" },
      headers: { Cookie: cookie },
    });
    expect(((await moved.json()) as { doc: DocSummary }).doc.projectId).toBe(doc.projectId);
    expect(api.broadcasts.at(-1)).toMatchObject({ type: "doc.updated", origin: "editor-a" });
    let after = await library(api, cookie);
    expect(after.noProjectDocs).toEqual([]);
    expect(after.projects[0]!.docs).toHaveLength(2);

    await api.call("PATCH", `/api/docs/${doc.id}`, {
      body: { projectId: null },
      headers: { Cookie: cookie },
    });
    after = await library(api, cookie);
    expect(after.noProjectDocs.map((entry) => entry.id)).toEqual([doc.id]);

    const missing = await api.call("PATCH", `/api/docs/${doc.id}`, {
      body: { projectId: "missing" },
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
    const empty = await api.call("PATCH", `/api/docs/${doc.id}`, {
      body: {},
      headers: { Cookie: cookie },
    });
    expect(empty.status).toBe(400);
  });
});

describe("doc threads", () => {
  const link = { environmentId: "env-1", threadId: "thread-1", title: "Build the importer" };

  it("links a thread once, relabels on repeat, unlinks, and pushes the list each time", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc } = await seedDoc(api, cookie);
    const headers = { Cookie: cookie };

    const created = await api.call("POST", `/api/docs/${doc.id}/threads`, {
      body: { ...link, clientId: "editor-a" },
      headers,
    });
    expect(created.status).toBe(201);
    const { threads } = (await created.json()) as { threads: Array<DocThreadLink> };
    expect(threads).toMatchObject([{ ...link, docId: doc.id }]);
    expect(api.broadcasts.at(-1)).toEqual({ type: "doc.threads", threads, origin: "editor-a" });

    // A retried report links the same thread, so it only refreshes the label.
    await api.call("POST", `/api/docs/${doc.id}/threads`, {
      body: { ...link, title: "Renamed" },
      headers,
    });
    const listed = await api.call("GET", `/api/docs/${doc.id}/threads`, { headers });
    const after = ((await listed.json()) as { threads: Array<DocThreadLink> }).threads;
    expect(after).toMatchObject([{ id: threads[0]!.id, title: "Renamed" }]);

    const removed = await api.call(
      "DELETE",
      `/api/docs/${doc.id}/threads/${threads[0]!.id}?clientId=editor-a`,
      { headers },
    );
    expect(await removed.json()).toEqual({ threads: [] });
    expect(api.broadcasts.at(-1)).toEqual({ type: "doc.threads", threads: [], origin: "editor-a" });
    const again = await api.call("DELETE", `/api/docs/${doc.id}/threads/${threads[0]!.id}`, {
      headers,
    });
    expect(again.status).toBe(404);
  });

  it("lets agents read links but only the owner's same-origin session write them", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc } = await seedDoc(api, cookie);
    const created = await api.call("POST", "/api/tokens", {
      body: { name: "agent" },
      headers: { Cookie: cookie },
    });
    const bearer = {
      Authorization: `Bearer ${((await created.json()) as { token: string }).token}`,
    };

    const byToken = await api.call("POST", `/api/docs/${doc.id}/threads`, {
      body: link,
      headers: bearer,
    });
    expect(byToken.status).toBe(403);
    const crossSite = await api.call("POST", `/api/docs/${doc.id}/threads`, {
      body: link,
      headers: { Cookie: cookie, Origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
    expect((await api.call("GET", `/api/docs/${doc.id}/threads`, { headers: bearer })).status).toBe(
      200,
    );
  });

  it("validates the link and the doc", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc } = await seedDoc(api, cookie);
    const headers = { Cookie: cookie };
    const missingThread = await api.call("POST", `/api/docs/${doc.id}/threads`, {
      body: { ...link, threadId: "" },
      headers,
    });
    expect(missingThread.status).toBe(400);
    const missingDoc = await api.call("POST", "/api/docs/missing/threads", { body: link, headers });
    expect(missingDoc.status).toBe(404);
  });

  it("go away with their doc", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { doc } = await seedDoc(api, cookie);
    await api.call("POST", `/api/docs/${doc.id}/threads`, {
      body: link,
      headers: { Cookie: cookie },
    });
    await api.db.prepare("DELETE FROM docs WHERE id = ?").bind(doc.id).run();
    const { results } = await api.db.prepare("SELECT * FROM doc_threads").all();
    expect(results).toEqual([]);
  });
});

describe("DocRoom errors", () => {
  it("restore their class after crossing Durable Object RPC as plain errors", () => {
    const overRpc = (cause: Error) => Docs.reviveError(new Error(cause.message));
    expect(overRpc(new Docs.InvalidMoveError())).toBeInstanceOf(Docs.InvalidMoveError);
    expect(overRpc(new Docs.LastTabError())).toBeInstanceOf(Docs.LastTabError);
    expect(overRpc(new Docs.NotFoundError("tab"))).toBeInstanceOf(Docs.NotFoundError);
    expect(overRpc(new Error("boom"))).not.toBeInstanceOf(Docs.NotFoundError);
  });
});
