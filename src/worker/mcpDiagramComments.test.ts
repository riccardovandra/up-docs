import { describe, expect, it } from "vitest";

import type { DiagramThread } from "../shared/diagramComments.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const box = (id: string, label: string, x = 40) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;html=1;" vertex="1" parent="1">` +
  `<mxGeometry x="${x}" y="40" width="120" height="60" as="geometry"/></mxCell>`;

/** The admin's agent and a diagram of theirs, with a thread the admin pinned on a shape in the page. */
async function setup() {
  const mcp = await makeMcpHarness();
  const created = await mcp.tool("create_drawio", {
    title: "Sales flow",
    xml: model(box("a", "Discovery call") + box("b", "Proposal", 240)),
  });
  expect(created.isError).toBe(false);
  const diagramId = created.body.diagramId as string;
  const response = await mcp.api.call("POST", `/api/diagrams/${diagramId}/comments`, {
    body: { anchor: { shapeId: "b" }, body: "Call this Proposal sent" },
    headers: { Cookie: mcp.cookie },
  });
  expect(response.status).toBe(201);
  const { thread } = (await response.json()) as { thread: DiagramThread };
  return { mcp, diagramId, thread };
}

describe("MCP diagram comments", () => {
  it("runs the loop: list, change the diagram, reply as the agent, resolve", async () => {
    const { mcp, diagramId, thread } = await setup();

    const listed = await mcp.tool("list_comments", {
      diagramId: `${ORIGIN}/diagrams/${diagramId}`,
    });
    expect(listed.isError).toBe(false);
    expect(listed.body.threads).toEqual([
      expect.objectContaining({
        commentId: thread.id,
        authorKind: "person",
        page: null,
        shapeId: "b",
        quote: "Proposal",
        shapeLabel: "Proposal",
        status: "shape",
        resolved: false,
        body: "Call this Proposal sent",
      }),
    ]);

    const read = await mcp.tool("read_drawio", { diagramId, includeXml: true });
    expect(read.body.openComments).toEqual([
      expect.objectContaining({ commentId: thread.id, shapeId: "b", quote: "Proposal" }),
    ]);
    const updated = await mcp.tool("update_drawio", {
      diagramId,
      baseVersion: read.body.version,
      xml: (read.body.xml as string).replace('value="Proposal"', 'value="Proposal sent"'),
    });
    expect(updated.isError).toBe(false);

    const reply = await mcp.tool("reply_comment", {
      diagramId,
      commentId: thread.id,
      body: "Renamed the shape to Proposal sent.",
    });
    expect(reply.isError).toBe(false);
    expect(reply.body.reply).toMatchObject({
      author: "agent:agent",
      authorKind: "agent",
      threadId: thread.id,
    });
    const resolved = await mcp.tool("resolve_comment", { diagramId, commentId: thread.id });
    expect(resolved.body).toEqual({ threadId: thread.id, diagramId, resolved: true });

    // Open threads only by default; the resolved one reads as resolved, its pin on the renamed shape.
    expect((await mcp.tool("list_comments", { diagramId })).body.threads).toEqual([]);
    const all = await mcp.tool("list_comments", { diagramId, includeResolved: true });
    expect(all.body.threads[0]).toMatchObject({
      resolved: true,
      quote: "Proposal",
      shapeLabel: "Proposal sent",
      status: "shape",
      replies: [expect.objectContaining({ authorKind: "agent" })],
    });
    expect((await mcp.tool("read_drawio", { diagramId })).body).not.toHaveProperty("openComments");

    const page = await mcp.api.call("GET", `/api/diagrams/${diagramId}/comments`, {
      headers: { Cookie: mcp.cookie },
    });
    const seen = (await page.json()) as { threads: Array<DiagramThread> };
    expect(seen.threads[0]!.resolvedAt).not.toBeNull();
    expect(seen.threads[0]!.replies[0]!.authorKind).toBe("agent");
  });

  it("finds a diagram comment by id alone, and keeps doc comments working", async () => {
    const { mcp, thread } = await setup();
    const reply = await mcp.tool("reply_comment", { commentId: thread.id, body: "On it." });
    expect(reply.isError).toBe(false);
    expect(reply.body.reply.threadId).toBe(thread.id);

    const seeded = await mcp.seedDoc("Intro text");
    const docComment = await mcp.tool("create_comment", {
      tabId: seeded.tab.tabId,
      quote: "Intro",
      body: "Shorter?",
    });
    const docReply = await mcp.tool("reply_comment", {
      commentId: docComment.body.comment.commentId,
      body: "Done",
    });
    expect(docReply.isError).toBe(false);
    expect(docReply.body).not.toHaveProperty("diagramId");
  });

  it("lets the agent pin its own comments, and refuses bad anchors and other diagrams", async () => {
    const { mcp, diagramId, thread } = await setup();
    const onShape = await mcp.tool("create_comment", {
      diagramId,
      anchor: { shapeId: "a" },
      body: "Is this the first call?",
    });
    expect(onShape.body.comment).toMatchObject({ shapeId: "a", quote: "Discovery call", authorKind: "agent" });
    const atPoint = await mcp.tool("create_comment", {
      diagramId,
      anchor: { x: 500, y: 300 },
      body: "Space for a follow-up step",
    });
    expect(atPoint.body.comment).toMatchObject({ shapeId: null, status: "point", point: { x: 500, y: 300 } });

    const bad = await mcp.tool("create_comment", { diagramId, anchor: { shapeId: "zz" }, body: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toBe("shape_not_found");

    const other = await mcp.tool("create_drawio", { title: "Other", xml: model(box("c", "C")) });
    const wrong = await mcp.tool("reply_comment", {
      diagramId: other.body.diagramId,
      commentId: thread.id,
      body: "x",
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.body.error).toBe("not_found");
    expect((await mcp.tool("list_comments", {})).body.error).toBe("invalid_argument");
  });

  it("lets someone who only reads the diagram list its threads but not answer them", async () => {
    const { mcp, diagramId, thread } = await setup();
    const seeded = await mcp.seedDoc(`Intro\n\n\`\`\`t3-drawio\n${diagramId}\n\`\`\`\n`);
    expect(
      (await mcp.tool("share_doc", { docId: seeded.doc.docId, email: "reader@example.com", role: "editor" }))
        .isError,
    ).toBe(false);
    const reader = await mcp.asUser("reader@example.com");
    expect((await reader("list_comments", { diagramId })).body.threads).toHaveLength(1);
    const refused = await reader("reply_comment", { diagramId, commentId: thread.id, body: "x" });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toBe("forbidden");
  });
});
