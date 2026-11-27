import { describe, expect, it } from "vitest";

import * as Designs from "./designs.ts";
import { MAX_INSTRUCTIONS_LENGTH, MCP_INSTRUCTIONS } from "./mcp.ts";
import { designIdsIn } from "./mcpDesigns.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeDesignRooms } from "./testing/designHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

const FIG = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

async function setup(options: { isolatedEditor?: boolean } = {}) {
  const rooms = makeDesignRooms(options);
  const mcp = await makeMcpHarness(ORIGIN, rooms.port);
  const created = await mcp.tool("create_design", { title: "Landing page" });
  expect(created.isError).toBe(false);
  const designId = created.body.designId as string;
  /** The whole tools/call result: JSON text and any attached images. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const { result } = await mcp.rpc("tools/call", { name, arguments: args });
    const content = result!.content as unknown as Array<Record<string, string>>;
    return {
      isError: result!.isError === true,
      body: JSON.parse(content[0]!.text!) as any,
      images: content.slice(1),
    };
  };
  return { rooms, mcp, designId, call };
}

/** Lets microtask answers and the bridge's timers line up, then fires the 20 s timeouts. */
const settleThenTimeOut = async (rooms: ReturnType<typeof makeDesignRooms>) => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  rooms.timeOut();
};

describe("MCP design tools", () => {
  it("lists the design tools", async () => {
    const { mcp } = await setup();
    const list = await mcp.rpc("tools/list");
    const names = (list.result!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_designs",
        "create_design",
        "read_design",
        "design_tools",
        "run_design_tools",
        "undo_design",
        "export_design",
      ]),
    );
  });

  it("creates an empty design with its link and block, and lists it with whether it is open", async () => {
    const { mcp, rooms, designId } = await setup();
    const project = await mcp.tool("create_project", { name: "Acme" });
    const filed = await mcp.tool("create_design", { title: "Pricing", projectId: project.body.projectId });
    expect(filed.body).toMatchObject({
      title: "Pricing",
      url: `${ORIGIN}/designs/${filed.body.designId}`,
      projectId: project.body.projectId,
      version: 0,
      pictureUrl: null,
      block: `\`\`\`t3-design\n${filed.body.designId}\n\`\`\``,
    });
    expect((await mcp.tool("create_design", {})).body.title).toBe("Untitled design");
    expect((await mcp.tool("create_design", { title: "" })).isError).toBe(true);

    await rooms.open(designId);
    const all = (await mcp.tool("list_designs", {})).body.designs as Array<any>;
    expect(all.map((design) => [design.title, design.open])).toEqual(
      expect.arrayContaining([
        ["Landing page", true],
        ["Pricing", false],
      ]),
    );
    const inProject = (await mcp.tool("list_designs", { projectId: project.body.projectId })).body;
    expect(inProject.designs.map((design: any) => design.title)).toEqual(["Pricing"]);
    const none = (await mcp.tool("list_designs", { noProject: true })).body;
    expect(none.designs.map((design: any) => design.title)).not.toContain("Pricing");
  });

  it("reads the saved copy with its picture when no editor is open", async () => {
    const { mcp, designId, call } = await setup();
    const owner = await mcp.api.db.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
    await Designs.saveDesignVersion(mcp.api.db, mcp.api.deps.images, {
      designId,
      baseVersion: 0,
      fig: FIG.slice().buffer,
      png: PNG.slice().buffer,
      createdBy: owner!.id,
      now: 1,
    });
    const read = await call("read_design", { designId: `${ORIGIN}/designs/${designId}` });
    expect(read.isError).toBe(false);
    expect(read.body).toMatchObject({
      designId,
      title: "Landing page",
      version: 1,
      open: false,
      pictureUrl: `${ORIGIN}/api/designs/${designId}/picture/1`,
    });
    expect(read.body.live).toContain(`${ORIGIN}/designs/${designId}`);
    expect(read.body.layers).toBeUndefined();
    expect(read.images).toEqual([
      { type: "image", data: btoa(String.fromCharCode(...PNG)), mimeType: "image/png" },
    ]);
    // The saved picture when exporting with no editor open; svg and layers need it open.
    const exported = await call("export_design", { designId });
    expect(exported.body.open).toBe(false);
    expect(exported.images).toHaveLength(1);
    const svg = await call("export_design", { designId, format: "svg" });
    expect(svg.body.error).toBe("not_open");
  });

  it("answers not_open with the link for edits when no editor has the design open", async () => {
    const { designId, call } = await setup();
    const url = `${ORIGIN}/designs/${designId}`;
    for (const [name, args] of [
      ["run_design_tools", { designId, calls: [{ name: "create_shape", args: { type: "FRAME", x: 0, y: 0 } }] }],
      ["undo_design", { designId }],
    ] as const) {
      const answer = await call(name, args);
      expect(answer.isError).toBe(true);
      expect(answer.body).toMatchObject({ error: "not_open", url });
      expect(answer.body.message).toContain(url);
    }
  });

  it("runs a batch in the open editor in order, then undoes only the agent's changes", async () => {
    const { rooms, designId, call } = await setup();
    const editor = await rooms.open(designId);
    const run = await call("run_design_tools", {
      designId,
      calls: [
        { name: "create_shape", args: { type: "FRAME", x: 0, y: 0, name: "Hero" } },
        { name: "set_fill", args: { id: "1:1", color: "#ff5500" } },
        { name: "create_shape", args: { type: "TEXT", x: 10, y: 10 } },
      ],
    });
    expect(run.isError).toBe(false);
    expect(run.body.ran).toBe(3);
    expect(run.body.results).toEqual([
      { name: "create_shape", result: { id: "1:1" } },
      { name: "set_fill", result: { id: "1:1", fill: "#ff5500" } },
      { name: "create_shape", result: { id: "1:2" } },
    ]);
    expect(editor.nodes.map((node) => node.name)).toEqual(["Hero", "TEXT"]);

    // The user's own change on top: the agent may not undo it.
    editor.history.push({ label: "Rename", undo: () => undefined });
    const blocked = await call("undo_design", { designId });
    expect(blocked.body.error).toBe("cannot_undo");
    editor.history.pop();

    const undone = await call("undo_design", { designId, steps: 2 });
    expect(undone.body.undone).toEqual(["Agent: create_shape", "Agent: set_fill"]);
    expect(editor.nodes[0]!.fill).toBeUndefined();
    expect(editor.nodes).toHaveLength(1);
    const rest = await call("undo_design", { designId, steps: 5 });
    expect(rest.body).toMatchObject({ undone: ["Agent: create_shape"], stopped: "Nothing more to undo." });
    expect(editor.nodes).toHaveLength(0);
    expect((await call("undo_design", { designId, steps: 0 })).body.error).toBe("invalid_argument");
  });

  it("stops at the first failing call and says what ran", async () => {
    const { rooms, designId, call } = await setup();
    const editor = await rooms.open(designId);
    const run = await call("run_design_tools", {
      designId,
      calls: [
        { name: "create_shape", args: { type: "FRAME", x: 0, y: 0 } },
        { name: "set_fill", args: { id: "9:9", color: "#000000" } },
        { name: "create_shape", args: { type: "FRAME", x: 0, y: 0 } },
      ],
    });
    expect(run.isError).toBe(true);
    expect(run.body).toMatchObject({
      error: "tool_failed",
      ran: 1,
      failedAt: 1,
      failedCall: "set_fill",
      results: [{ name: "create_shape", result: { id: "1:1" } }],
    });
    expect(run.body.message).toContain('Node "9:9" not found');
    expect(editor.received).toHaveLength(2);
  });

  it("refuses unknown and blocked tools before anything runs", async () => {
    const { rooms, designId, call } = await setup();
    const editor = await rooms.open(designId);
    const run = await call("run_design_tools", {
      designId,
      calls: [
        { name: "create_shape", args: { type: "FRAME", x: 0, y: 0 } },
        { name: "eval", args: { code: "1" } },
        { name: "search_web", args: {} },
      ],
    });
    expect(run.body).toMatchObject({ error: "not_allowed", unknown: ["eval", "search_web"] });
    expect(editor.received).toEqual([]);
    for (const calls of [[], [{ args: {} }], [{ name: "list_pages", args: [] }], Array(51).fill({ name: "list_pages" })]) {
      expect((await call("run_design_tools", { designId, calls })).body.error).toBe("invalid_argument");
    }
  });

  it("hides and refuses the code-compiling tools when the editor shares the app's origin", async () => {
    const isolated = await setup();
    await isolated.rooms.open(isolated.designId);
    expect((await isolated.call("design_tools", { names: ["render"] })).body.tools).toHaveLength(1);
    expect(
      (await isolated.call("run_design_tools", { designId: isolated.designId, calls: [{ name: "render", args: { jsx: "<Frame/>" } }] })).isError,
    ).toBe(false);

    const fallback = await setup({ isolatedEditor: false });
    const editor = await fallback.rooms.open(fallback.designId);
    const listed = await fallback.call("design_tools", {});
    expect(JSON.stringify(listed.body.categories)).not.toContain('"render"');
    expect(listed.body.note).toContain("render");
    expect((await fallback.call("design_tools", { names: ["render"] })).body).toMatchObject({
      tools: [],
      unknown: ["render"],
    });
    const run = await fallback.call("run_design_tools", {
      designId: fallback.designId,
      calls: [{ name: "render", args: { jsx: "<Frame/>" } }],
    });
    expect(run.body.error).toBe("not_allowed");
    expect(editor.received).toEqual([]);
  });

  it("lists tools by category, and hands out schemas by name", async () => {
    const { call } = await setup();
    const listed = (await call("design_tools", {})).body;
    expect(listed.categories.create.map((tool: any) => tool.name)).toEqual(["create_shape", "render"]);
    expect(listed.categories.read[0]).toEqual({ name: "list_pages", description: "List all pages in the document." });
    expect(listed.categories.create[0].changes).toBe(true);
    expect((await call("design_tools", { category: "edit" })).body.categories).toEqual({
      edit: [{ name: "set_fill", description: "Set fill on a node.", changes: true }],
    });
    expect(Object.keys((await call("design_tools", { filter: "SVG" })).body.categories)).toEqual(["export"]);
    const named = (await call("design_tools", { names: ["export_svg", "nope"] })).body;
    expect(named.unknown).toEqual(["nope"]);
    // The file-writing argument is not offered.
    expect(named.tools[0].inputSchema.properties).toEqual({ ids: { type: "array" } });
    expect((await call("design_tools", { category: "x" })).body.error).toBe("invalid_argument");
  });

  it("reads the live layer tree and selection while open, and exports PNG and SVG from the editor", async () => {
    const { rooms, designId, call } = await setup();
    await rooms.open(designId);
    await call("run_design_tools", {
      designId,
      calls: [{ name: "create_shape", args: { type: "FRAME", x: 0, y: 0, name: "Hero" } }],
    });
    const read = await call("read_design", { designId });
    expect(read.body).toMatchObject({
      open: true,
      pages: [{ id: "0:1", name: "Page 1" }],
      layers: { nodes: [{ id: "1:1", type: "FRAME", name: "Hero" }] },
      selection: [],
    });
    const png = await call("export_design", { designId, nodeIds: ["1:1"], scale: 2 });
    expect(png.images).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
    const editor = rooms.room(designId).editors.at(-1)!;
    expect(editor.received.at(-1)).toEqual({
      command: "export",
      args: { nodeIds: ["1:1"], scale: 2, format: "PNG" },
    });
    const svg = await call("export_design", { designId, format: "svg" });
    expect(svg.body.svg).toBe("<svg/>");
  });

  it("cuts long results short", async () => {
    const { rooms, designId, call } = await setup();
    await rooms.open(designId);
    const run = await call("run_design_tools", { designId, calls: [{ name: "get_jsx", args: {} }] });
    expect(run.body.results[0].result.truncated).toContain("characters");
    expect(run.body.results[0].result.start).toHaveLength(20_000);
  });

  it("reports an editor that does not answer in time, and one that closes mid-call", async () => {
    const { rooms, designId, call } = await setup();
    const editor = await rooms.open(designId);
    editor.hang.add("set_fill");
    const pending = call("run_design_tools", {
      designId,
      calls: [
        { name: "create_shape", args: { type: "FRAME", x: 0, y: 0 } },
        { name: "set_fill", args: { id: "1:1", color: "#111111" } },
      ],
    });
    await settleThenTimeOut(rooms);
    const timedOut = await pending;
    expect(timedOut.body).toMatchObject({ error: "editor_timeout", ran: 1, failedAt: 1 });

    const closing = call("run_design_tools", {
      designId,
      calls: [{ name: "set_fill", args: { id: "1:1", color: "#222222" } }],
    });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    rooms.close(designId);
    expect((await closing).body.error).toBe("editor_closed");
  });

  it("checks the person's role: viewers read, only editors change", async () => {
    const { mcp, rooms, designId } = await setup();
    await rooms.open(designId);
    const seeded = await mcp.seedDoc("x");
    await mcp.tool("share_doc", { docId: seeded.doc.docId, email: "v@example.com", role: "viewer" });
    const asViewer = await mcp.asUser("v@example.com");
    expect((await asViewer("read_design", { designId })).body.error).toBe("not_found");
    const user = await mcp.api.db
      .prepare("SELECT id FROM users WHERE email = 'v@example.com'")
      .first<{ id: string }>();
    await mcp.api.db
      .prepare("INSERT INTO design_members (id, design_id, user_id, role, created_at) VALUES ('m', ?, ?, 'viewer', 0)")
      .bind(designId, user!.id)
      .run();
    expect((await asViewer("read_design", { designId })).isError).toBe(false);
    const write = await asViewer("run_design_tools", {
      designId,
      calls: [{ name: "create_shape", args: { type: "FRAME", x: 0, y: 0 } }],
    });
    expect(write.body.error).toBe("forbidden");
    expect((await asViewer("undo_design", { designId })).body.error).toBe("forbidden");
    expect(
      (await asViewer("run_design_tools", { designId, calls: [{ name: "list_pages" }] })).isError,
    ).toBe(false);
  });

  it("shows the designs a doc's t3-design blocks name in read_doc", async () => {
    const { mcp, designId } = await setup();
    const markdown = `Intro\n\n\`\`\`t3-design\n${designId}\nframe: Hero\nThe landing page\n\`\`\`\n\n\`\`\`t3-design\nmissing1\n\`\`\``;
    const seeded = await mcp.seedDoc(markdown);
    const read = (await mcp.tool("read_doc", { docId: seeded.doc.docId })).body;
    expect(read.designs).toEqual([
      { designId, title: "Landing page", url: `${ORIGIN}/designs/${designId}`, pictureUrl: null },
      { designId: "missing1", missing: expect.stringContaining("No design") },
    ]);
    const tab = (await mcp.tool("read_doc", { docId: seeded.doc.docId, tabId: seeded.tab.tabId })).body;
    expect(tab.designs).toHaveLength(2);
    expect(designIdsIn("```t3-design\n  abc  \n```\n~~~t3-design\nabc\n~~~\n```t3-drawio\nzzz\n```")).toEqual(["abc"]);
  });

  it("routes designs and keeps diagrams on Draw.io in the instructions, within the length limit", async () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH);
    expect(MCP_INSTRUCTIONS).toContain("A design (mockup, UI screen, landing page layout): create_design");
    expect(MCP_INSTRUCTIONS).toContain('"A diagram" (a flowchart, map, process or system drawing) on its own: one Draw.io diagram');
    const { mcp } = await setup();
    const guide = (await mcp.tool("format_guide", { topic: "design" })).body.guide as string;
    expect(guide).toContain("run_design_tools");
    expect(guide).toContain("not_open");
  });

  it("says the bridge is unavailable where the endpoint has none", async () => {
    const mcp = await makeMcpHarness();
    const created = await mcp.tool("create_design", { title: "x" });
    expect((await mcp.tool("design_tools", {})).body.error).toBe("unavailable");
    expect((await mcp.tool("read_design", { designId: created.body.designId })).body.open).toBe(false);
    const run = await mcp.tool("run_design_tools", {
      designId: created.body.designId,
      calls: [{ name: "list_pages" }],
    });
    expect(run.body.error).toBe("unavailable");
  });
});
