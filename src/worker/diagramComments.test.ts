import { describe, expect, it } from "vitest";

import type { DiagramComment, DiagramThread } from "../shared/diagramComments.ts";
import { drawioBlock, type DiagramListItem, type DiagramView } from "../shared/drawio.ts";
import type { DrawioPageLayout } from "../shared/drawioModel.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

const XML =
  '<mxfile><diagram name="Flow" id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="a" value="Discovery call" style="rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
  "</root></mxGraphModel></diagram></mxfile>";

type Listed = { threads: Array<DiagramThread>; pages: Array<DrawioPageLayout> };

/** The admin, a creator who makes a diagram, and a doc linking it that a reader is on. */
async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie } });
    return { status: response.status, body: (await response.json()) as A };
  };
  const doc = (await send<DocWithTabs>(admin, "POST", "/api/docs", { title: "Playbook" })).body;
  const member = async (email: string, role: string) => {
    await send(admin, "POST", `/api/docs/${doc.doc.id}/members`, { email, role });
    return api.signIn(email);
  };
  const creator = await member("creator@example.com", "editor");
  const reader = await member("reader@example.com", "commenter");
  const diagram = (
    await send<{ diagram: DiagramView }>(creator, "POST", "/api/diagrams", {
      title: "Sales flow",
      xml: XML,
    })
  ).body.diagram;
  const tab = doc.tabs[0]!;
  const current = (await send<{ tab: { version: number } }>(creator, "GET", `/api/tabs/${tab.id}`))
    .body.tab;
  await send(creator, "PATCH", `/api/tabs/${tab.id}`, {
    baseVersion: current.version,
    markdown: `Intro\n\n${drawioBlock(diagram.id)}\n`,
  });
  // An account of their own, on a doc that does not link the diagram.
  const other = (await send<DocWithTabs>(admin, "POST", "/api/docs", { title: "Other" })).body;
  await send(admin, "POST", `/api/docs/${other.doc.id}/members`, {
    email: "stranger@example.com",
    role: "editor",
  });
  const stranger = await api.signIn("stranger@example.com");
  return { api, admin, creator, reader, stranger, diagram, send };
}

describe("diagram comments API", () => {
  it("stores a thread on a shape with its label, then replies, resolves and reopens it", async () => {
    const { creator, admin, diagram, send } = await setup();
    const created = await send<{ thread: DiagramThread }>(
      creator,
      "POST",
      `/api/diagrams/${diagram.id}/comments`,
      { anchor: { page: "Flow", shapeId: "a" }, body: "Make this two steps" },
    );
    expect(created.status).toBe(201);
    const thread = created.body.thread;
    expect(thread).toMatchObject({
      diagramId: diagram.id,
      parentId: null,
      // A shape anchor without a point takes the shape's top-right corner.
      anchor: { page: "Flow", shapeId: "a", x: 160, y: 40 },
      quote: "Discovery call",
      author: "creator@example.com",
      authorKind: "person",
      resolvedAt: null,
      replies: [],
    });

    const point = await send<{ thread: DiagramThread }>(
      admin,
      "POST",
      `/api/diagrams/${diagram.id}/comments`,
      { anchor: { x: 300, y: 10 }, body: "Something here?" },
    );
    expect(point.body.thread.anchor).toEqual({ page: "Flow", shapeId: null, x: 300, y: 10 });
    expect(point.body.thread.quote).toBe("");

    const replied = await send<{ reply: DiagramComment; thread: DiagramThread }>(
      admin,
      "POST",
      `/api/diagram-comments/${thread.id}/replies`,
      { body: "Agreed" },
    );
    expect(replied.status).toBe(201);
    expect(replied.body.reply).toMatchObject({ parentId: thread.id, anchor: null, body: "Agreed" });
    // Replying to a reply joins the thread.
    await send(creator, "POST", `/api/diagram-comments/${replied.body.reply.id}/replies`, {
      body: "Thanks",
    });

    const resolved = await send<{ thread: DiagramThread }>(
      creator,
      "POST",
      `/api/diagram-comments/${replied.body.reply.id}/resolve`,
      {},
    );
    expect(resolved.body.thread.id).toBe(thread.id);
    expect(resolved.body.thread.resolvedAt).not.toBeNull();
    expect(resolved.body.thread.replies.map((reply) => reply.body)).toEqual(["Agreed", "Thanks"]);

    const listed = await send<{ diagrams: Array<DiagramListItem> }>(creator, "GET", "/api/diagrams");
    expect(listed.body.diagrams[0]!.openComments).toBe(1);

    const reopened = await send<{ thread: DiagramThread }>(
      creator,
      "POST",
      `/api/diagram-comments/${thread.id}/reopen`,
      {},
    );
    expect(reopened.body.thread.resolvedAt).toBeNull();
    const all = await send<Listed>(creator, "GET", `/api/diagrams/${diagram.id}/comments`);
    expect(all.body.threads.map((each) => each.id)).toEqual([thread.id, point.body.thread.id]);
    expect(all.body.pages[0]!.shapes).toEqual([
      { id: "a", label: "Discovery call", x: 40, y: 40, width: 120, height: 60 },
    ]);
  });

  it("refuses anchors that name no page or shape, and empty comments", async () => {
    const { creator, diagram, send } = await setup();
    const post = (body: unknown) =>
      send<{ error: string }>(creator, "POST", `/api/diagrams/${diagram.id}/comments`, body);
    expect((await post({ anchor: { shapeId: "nope" }, body: "x" })).body.error).toBe(
      "shape_not_found",
    );
    expect((await post({ anchor: { page: "Other", x: 1, y: 1 }, body: "x" })).body.error).toBe(
      "page_not_found",
    );
    expect((await post({ anchor: { x: "1", y: 1 }, body: "x" })).body.error).toBe("invalid_anchor");
    expect((await post({ anchor: { x: 1, y: 1 }, body: "  " })).body.error).toBe("invalid_body");
  });

  it("lets a reader of a linking doc read threads but not write, and hides them from strangers", async () => {
    const { creator, reader, stranger, diagram, send } = await setup();
    const { thread } = (
      await send<{ thread: DiagramThread }>(
        creator,
        "POST",
        `/api/diagrams/${diagram.id}/comments`,
        { anchor: { shapeId: "a" }, body: "Make this two steps" },
      )
    ).body;
    const read = await send<Listed>(reader, "GET", `/api/diagrams/${diagram.id}/comments`);
    expect(read.status).toBe(200);
    expect(read.body.threads).toHaveLength(1);

    expect(
      (await send(reader, "POST", `/api/diagrams/${diagram.id}/comments`, {
        anchor: { shapeId: "a" },
        body: "x",
      })).status,
    ).toBe(403);
    expect(
      (await send(reader, "POST", `/api/diagram-comments/${thread.id}/replies`, { body: "x" }))
        .status,
    ).toBe(403);
    expect(
      (await send(reader, "POST", `/api/diagram-comments/${thread.id}/resolve`, {})).status,
    ).toBe(403);

    expect((await send(stranger, "GET", `/api/diagrams/${diagram.id}/comments`)).status).toBe(404);
    expect(
      (await send(stranger, "POST", `/api/diagram-comments/${thread.id}/replies`, { body: "x" }))
        .status,
    ).toBe(404);
  });

  it("deletes a diagram's threads with it", async () => {
    const { api, creator, diagram, send } = await setup();
    await send(creator, "POST", `/api/diagrams/${diagram.id}/comments`, {
      anchor: { shapeId: "a" },
      body: "x",
    });
    expect((await send(creator, "DELETE", `/api/diagrams/${diagram.id}`)).status).toBe(200);
    const left = await api.db.prepare("SELECT COUNT(*) AS n FROM diagram_comments").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });
});
