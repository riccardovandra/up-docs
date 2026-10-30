import { describe, expect, it } from "vitest";

import type { Comment, DocWithTabs } from "../shared/protocol.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

async function setup() {
  const api = makeApiHarness();
  const cookie = await api.signIn();
  const owner = { Cookie: cookie };
  const project = await api.call("POST", "/api/projects", {
    body: { name: "Acme" },
    headers: owner,
  });
  const { project: created } = (await project.json()) as { project: { id: string } };
  const docResponse = await api.call("POST", "/api/docs", {
    body: { projectId: created.id, title: "Plan" },
    headers: owner,
  });
  const doc = (await docResponse.json()) as DocWithTabs;
  const tab = doc.tabs[0]!;
  const token = await api.call("POST", "/api/tokens", {
    body: { name: "laptop" },
    headers: owner,
  });
  const bearer = {
    Authorization: `Bearer ${((await token.json()) as { token: string }).token}`,
  };

  const comment = async (headers: Record<string, string>, body = "Why Friday?") => {
    const response = await api.call("POST", `/api/tabs/${tab.id}/comments`, {
      body: { quote: "Friday", prefix: "ships ", suffix: ".", body, clientId: "editor-1" },
      headers,
    });
    return {
      status: response.status,
      comment: ((await response.json()) as { comment: Comment }).comment,
    };
  };

  return { api, owner, bearer, doc, tab, comment };
}

describe("comment routes", () => {
  it("need a session or token, and same-origin writes for sessions", async () => {
    const { api, owner, doc, tab } = await setup();
    expect((await api.call("GET", `/api/docs/${doc.doc.id}/comments`)).status).toBe(401);
    const crossSite = await api.call("POST", `/api/tabs/${tab.id}/comments`, {
      body: { quote: "x", body: "y" },
      headers: { ...owner, Origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
  });

  it("run a thread through reply, resolve, reopen and delete, broadcasting each step", async () => {
    const { api, owner, bearer, doc, comment } = await setup();
    const created = await comment(owner);
    expect(created.status).toBe(201);
    expect(created.comment).toMatchObject({
      quote: "Friday",
      author: "owner@example.com",
      parentId: null,
      resolvedAt: null,
    });

    const reply = await api.call("POST", `/api/comments/${created.comment.id}/replies`, {
      body: { body: "Because of the launch." },
      headers: bearer,
    });
    const { comment: replyComment } = (await reply.json()) as { comment: Comment };
    expect(replyComment).toMatchObject({ parentId: created.comment.id, author: "agent:laptop" });

    // Resolving through a reply resolves its thread.
    const resolved = await api.call("POST", `/api/comments/${replyComment.id}/resolve`, {
      body: {},
      headers: owner,
    });
    const { comment: root } = (await resolved.json()) as { comment: Comment };
    expect(root.id).toBe(created.comment.id);
    expect(root.resolvedAt).not.toBeNull();

    const reopened = await api.call("POST", `/api/comments/${root.id}/reopen`, {
      body: {},
      headers: owner,
    });
    expect(((await reopened.json()) as { comment: Comment }).comment.resolvedAt).toBeNull();

    const listed = await api.call("GET", `/api/docs/${doc.doc.id}/comments`, { headers: owner });
    expect(((await listed.json()) as { comments: Array<Comment> }).comments).toHaveLength(2);

    const deleted = await api.call("DELETE", `/api/comments/${root.id}`, { headers: owner });
    expect(await deleted.json()).toEqual({
      kind: "deleted",
      commentIds: [root.id, replyComment.id],
    });
    const after = await api.call("GET", `/api/docs/${doc.doc.id}/comments`, { headers: owner });
    expect(((await after.json()) as { comments: Array<Comment> }).comments).toEqual([]);

    expect(api.broadcasts.map((message) => message.type)).toEqual([
      "comment.created",
      "comment.created",
      "comment.updated",
      "comment.updated",
      "comment.deleted",
    ]);
    expect(api.broadcasts[0]).toMatchObject({ origin: "editor-1" });
  });

  it("let the owner edit only owner comments, and an agent only its own", async () => {
    const { api, owner, bearer, comment } = await setup();
    const mine = (await comment(owner)).comment;
    const agents = (await comment(bearer, "From the agent")).comment;
    const edit = (id: string, headers: Record<string, string>) =>
      api.call("PATCH", `/api/comments/${id}`, { body: { body: "Edited" }, headers });

    expect((await edit(mine.id, owner)).status).toBe(200);
    expect((await edit(agents.id, owner)).status).toBe(403);
    expect((await edit(mine.id, bearer)).status).toBe(403);
    expect((await edit(agents.id, bearer)).status).toBe(200);

    expect((await api.call("DELETE", `/api/comments/${mine.id}`, { headers: bearer })).status).toBe(
      403,
    );
    expect(
      (await api.call("DELETE", `/api/comments/${agents.id}`, { headers: owner })).status,
    ).toBe(200);
  });

  it("validate anchors and bodies, and 404 unknown targets", async () => {
    const { api, owner } = await setup();
    const missingTab = await api.call("POST", "/api/tabs/nope/comments", {
      body: { quote: "x", body: "y" },
      headers: owner,
    });
    expect(missingTab.status).toBe(404);
    const reply = await api.call("POST", "/api/comments/nope/replies", {
      body: { body: "y" },
      headers: owner,
    });
    expect(reply.status).toBe(404);
  });

  it("refuse a comment whose passage is missing when the caller requires an anchor", async () => {
    const { api, owner, tab } = await setup();
    await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: { baseVersion: tab.version, markdown: "The beta ships **Friday**." },
      headers: owner,
    });
    const create = (quote: string) =>
      api.call("POST", `/api/tabs/${tab.id}/comments`, {
        body: { quote, prefix: "ships ", suffix: ".", body: "Imported", requireAnchor: true },
        headers: owner,
      });
    expect((await create("Friday")).status).toBe(201);
    const missing = await create("Monday");
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "anchor_not_found" });
  });

  it("are removed with their tab", async () => {
    const { api, owner, doc, comment } = await setup();
    const second = await api.call("POST", `/api/docs/${doc.doc.id}/tabs`, {
      body: { title: "Second" },
      headers: owner,
    });
    const { tab: secondTab } = (await second.json()) as { tab: { id: string } };
    await api.call("POST", `/api/tabs/${secondTab.id}/comments`, {
      body: { quote: "x", body: "On the second tab" },
      headers: owner,
    });
    await comment(owner);
    await api.call("DELETE", `/api/tabs/${secondTab.id}`, { headers: owner });
    const listed = await api.call("GET", `/api/docs/${doc.doc.id}/comments`, { headers: owner });
    const { comments } = (await listed.json()) as { comments: Array<Comment> };
    expect(comments.map((entry) => entry.body)).toEqual(["Why Friday?"]);
  });

  it("anchor a thread to a table cell and refuse a malformed or missing one", async () => {
    const { api, owner, doc, tab } = await setup();
    const table = {
      id: "t1",
      columns: [{ id: "a", name: "A", type: "text" }],
      rows: [{ id: "r1", cells: { a: "Fix Zebra" } }],
    };
    const invalid = await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: { baseVersion: tab.version, markdown: '```t3-table\n{"id": 1}\n```' },
      headers: owner,
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: "table_invalid" });
    await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: {
        baseVersion: tab.version,
        markdown: `\`\`\`t3-table\n${JSON.stringify(table)}\n\`\`\``,
      },
      headers: owner,
    });
    const post = (anchor: unknown) =>
      api.call("POST", `/api/tabs/${tab.id}/comments`, {
        body: { anchor, body: "Check the tickets" },
        headers: owner,
      });
    const cell = { kind: "cell", blockId: "t1", rowId: "r1", colId: "a" };
    const created = await post(cell);
    expect(created.status).toBe(201);
    expect(((await created.json()) as { comment: Comment }).comment).toMatchObject({
      anchor: cell,
      quote: "Fix Zebra",
      prefix: "",
    });
    expect((await post({ kind: "cell", blockId: "t1" })).status).toBe(400);
    expect((await post({ ...cell, rowId: "r2" })).status).toBe(409);

    const listed = await api.call("GET", `/api/docs/${doc.doc.id}/comments`, { headers: owner });
    const { comments } = (await listed.json()) as { comments: Array<Comment> };
    expect(comments.map((comment) => comment.anchor)).toEqual([cell]);
  });
});
