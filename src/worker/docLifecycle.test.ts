import { describe, expect, it } from "vitest";

import type { DocRole } from "../shared/access.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { handleApi } from "./api.ts";
import { makeApiHarness, ORIGIN } from "./testing/apiHarness.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function setup() {
  const api = makeApiHarness();
  const owner = await api.signIn();
  const { project } = (await (
    await api.call("POST", "/api/projects", { body: { name: "P" }, headers: { Cookie: owner } })
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
  const count = async (table: string) =>
    (await api.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE doc_id = ?`)
      .bind(docId)
      .first<{ n: number }>())!.n;
  return { api, owner, docId, tabId: created.tabs[0]!.id, person, count };
}

describe("doc rename", () => {
  it("lets editors rename and tells open pages", async () => {
    const { api, docId, person } = await setup();
    const editor = await person("e@example.com", "editor");
    const response = await api.call("PATCH", `/api/docs/${docId}`, {
      body: { title: "Roadmap", clientId: "page-1" },
      headers: { Cookie: editor },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { doc: { title: string } }).doc.title).toBe("Roadmap");
    expect(api.broadcasts.at(-1)).toMatchObject({
      type: "doc.updated",
      doc: { title: "Roadmap" },
      origin: "page-1",
    });
  });

  it("refuses commenters and blank titles", async () => {
    const { api, owner, docId, person } = await setup();
    const commenter = await person("c@example.com", "commenter");
    const refused = await api.call("PATCH", `/api/docs/${docId}`, {
      body: { title: "Mine" },
      headers: { Cookie: commenter },
    });
    expect(refused.status).toBe(403);
    const blank = await api.call("PATCH", `/api/docs/${docId}`, {
      body: { title: "  " },
      headers: { Cookie: owner },
    });
    expect(blank.status).toBe(400);
  });
});

describe("doc delete", () => {
  it("is for owners only", async () => {
    const { api, docId, person } = await setup();
    for (const role of ["editor", "commenter", "viewer"] as const) {
      const cookie = await person(`${role}@example.com`, role);
      const response = await api.call("DELETE", `/api/docs/${docId}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(403);
    }
    expect((await api.call("DELETE", `/api/docs/${docId}`)).status).toBe(401);
  });

  it("removes the doc with its tabs, comments, people and images, and closes sockets", async () => {
    const { api, owner, docId, tabId, person, count } = await setup();
    const viewer = await person("v@example.com", "viewer");
    await api.call("POST", `/api/tabs/${tabId}/comments`, {
      body: { quote: "x", body: "Note" },
      headers: { Cookie: owner },
    });
    await api.call("PATCH", `/api/tabs/${tabId}`, {
      body: { baseVersion: 1, markdown: "x" },
      headers: { Cookie: owner },
    });
    await handleApi(
      new Request(`${ORIGIN}/api/docs/${docId}/images`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: owner, "Content-Type": "image/png" },
        body: PNG,
      }),
      api.deps,
    );
    await api.call("GET", `/api/docs/${docId}/ws`, {
      headers: { Cookie: viewer, Upgrade: "websocket" },
    });
    expect(api.images.size).toBe(1);
    expect(await count("doc_members")).toBe(2);
    expect(await count("comments")).toBe(1);
    expect(api.sockets).toHaveLength(1);

    const response = await api.call("DELETE", `/api/docs/${docId}?clientId=page-1`, {
      headers: { Cookie: owner },
    });
    expect(response.status).toBe(200);
    expect(api.broadcasts.at(-1)).toEqual({ type: "doc.deleted", docId, origin: "page-1" });
    expect(api.sockets.every((socket) => !socket.open)).toBe(true);
    expect(api.images.size).toBe(0);
    for (const table of ["tabs", "comments", "doc_members"]) expect(await count(table)).toBe(0);
    for (const cookie of [owner, viewer]) {
      const read = await api.call("GET", `/api/docs/${docId}`, { headers: { Cookie: cookie } });
      expect(read.status).toBe(404);
    }
    expect(
      (await api.call("DELETE", `/api/docs/${docId}`, { headers: { Cookie: owner } })).status,
    ).toBe(404);
  });
});
