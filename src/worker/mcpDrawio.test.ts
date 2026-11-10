import { describe, expect, it } from "vitest";

import { drawioBlock, MAX_DIAGRAM_XML_BYTES } from "../shared/drawio.ts";
import { readDrawio } from "../shared/drawioModel.ts";
import * as Diagrams from "./diagrams.ts";
import * as Docs from "./docs.ts";
import { DRAWIO_EXAMPLE } from "./mcpGuide.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const box = (id: string, label: string) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;html=1;" vertex="1" parent="1">` +
  `<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>`;
const edge = (id: string, source: string, target: string, label = "") =>
  `<mxCell id="${id}" value="${label}" style="endArrow=block;html=1;" edge="1" parent="1" ` +
  `source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

const FLOW = model(box("a", "Discovery call") + box("b", "Proposal") + edge("e", "a", "b", "won"));
const FLOW2 = model(box("a", "Discovery call") + box("b", "Kickoff") + edge("e", "a", "b"));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

type Harness = Awaited<ReturnType<typeof makeMcpHarness>>;

/** The admin's agent, a doc of theirs in a project, and a diagram of theirs in that project. */
async function setup() {
  const mcp = await makeMcpHarness();
  const seeded = await mcp.seedDoc("Intro");
  const projectId = (await mcp.tool("list_projects", {})).body.projects[0].projectId as string;
  const created = await mcp.tool("create_drawio", { projectId, title: "Sales flow", xml: FLOW });
  expect(created.isError).toBe(false);
  return { mcp, projectId, ...seeded, diagramId: created.body.diagramId as string };
}

/** Someone else's agent. Sharing a doc with them is what gives them an account. */
async function agentOf(mcp: Harness, email: string, docId: string, role = "viewer") {
  expect((await mcp.tool("share_doc", { docId, email, role })).isError).toBe(false);
  return mcp.asUser(email);
}

const link = (mcp: Harness, tabId: string, diagramId: string) =>
  mcp.tool("edit_tab", {
    tabId,
    find: "Intro",
    replace: `Intro\n\n${drawioBlock(diagramId, "How a deal moves")}`,
  });

describe("MCP Draw.io tools", () => {
  it("lists them beside the code-drawn diagram tools, and guides with a valid example", async () => {
    const mcp = await makeMcpHarness();
    const list = await mcp.rpc("tools/list");
    const names = (list.result!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "read_diagram",
        "edit_diagram_label",
        "list_drawio",
        "read_drawio",
        "create_drawio",
        "update_drawio",
      ]),
    );

    const guide = (await mcp.tool("format_guide", { topic: "drawio" })).body.guide as string;
    expect(guide).toContain(DRAWIO_EXAMPLE);
    expect(guide).toContain("first time a person who manages the diagram opens it");
    const read = await readDrawio(DRAWIO_EXAMPLE);
    expect(read).toEqual({
      ok: true,
      pages: [
        {
          name: null,
          shapes: ["Discovery call", "Proposal", "Signed?", "Kickoff"],
          connections: [
            "Discovery call -> Proposal",
            "Proposal -> Signed?",
            "Signed? -[yes]-> Kickoff",
            "Signed? -[no: revise]-> Proposal",
          ],
          warnings: [],
          unreadable: null,
        },
      ],
    });
  });

  it("creates a diagram in a project and returns its id, link and block", async () => {
    const mcp = await makeMcpHarness();
    const created = await mcp.tool("create_drawio", {
      projectKey: "github.com/acme/app",
      projectName: "Acme",
      title: "Sales flow",
      xml: FLOW,
    });
    expect(created.isError).toBe(false);
    const { diagramId } = created.body as { diagramId: string };
    expect(created.body).toMatchObject({
      title: "Sales flow",
      version: 1,
      url: `${ORIGIN}/diagrams/${diagramId}`,
      block: `\`\`\`t3-drawio\n${diagramId}\n\`\`\``,
      shapes: ["Discovery call", "Proposal"],
      connections: ["Discovery call -[won]-> Proposal"],
    });
    expect(created.body.picture).toContain("first time a person who manages the diagram opens");
    expect(created.body.warnings).toBeUndefined();
    const projects = (await mcp.tool("list_projects", {})).body.projects;
    expect(created.body.projectId).toBe(projects[0].projectId);
    // What the agent wrote is what the editor opens.
    expect((await Diagrams.getDiagram(mcp.api.db, diagramId)).xml).toBe(FLOW);

    const loose = await mcp.tool("create_drawio", {
      title: "Loose",
      xml: model(box("a", "A") + edge("e", "a", "ghost")),
    });
    expect(loose.body.projectId).toBeNull();
    expect(loose.body.connections).toEqual(["A -> (loose end)"]);
    expect(loose.body.warnings).toEqual([
      'Connection "e" has target="ghost", but no cell has that id: that end is left loose.',
    ]);
  });

  it("refuses XML the editor could not open, and saves nothing", async () => {
    const mcp = await makeMcpHarness();
    const attempt = (xml: unknown) => mcp.tool("create_drawio", { title: "T", xml });

    const notDrawio = await attempt("<svg/>");
    expect(notDrawio).toMatchObject({ isError: true, body: { error: "invalid_xml" } });
    const malformed = await attempt(model(box("a", "Research & build")));
    expect(malformed).toMatchObject({ isError: true, body: { error: "invalid_xml" } });
    expect(malformed.body.message).toContain('line 1: a bare "&": write &amp;');
    expect(malformed.body.guide).toContain('topic: "drawio"');
    const huge = await attempt(model(box("a", "x".repeat(MAX_DIAGRAM_XML_BYTES))));
    expect(huge).toMatchObject({ isError: true, body: { error: "too_large" } });
    for (const xml of ["", "  ", undefined, 7]) {
      expect((await attempt(xml)).body.error).toBe("invalid_argument");
    }
    const untitled = await mcp.tool("create_drawio", { xml: FLOW });
    expect(untitled.body.error).toBe("invalid_argument");
    const elsewhere = await mcp.tool("create_drawio", { projectId: "nope", title: "T", xml: FLOW });
    expect(elsewhere.body.error).toBe("not_found");

    expect((await mcp.tool("list_drawio", {})).body.diagrams).toEqual([]);
  });

  it("lists the diagrams a person manages, by project, with the docs that link them", async () => {
    const { mcp, projectId, doc, tab, diagramId } = await setup();
    await link(mcp, tab.tabId, diagramId);
    const loose = await mcp.tool("create_drawio", { title: "Loose", xml: FLOW2 });

    const all = await mcp.tool("list_drawio", {});
    expect(all.body.diagrams).toHaveLength(2);
    const filed = await mcp.tool("list_drawio", { projectId });
    expect(filed.body.diagrams).toEqual([
      {
        diagramId,
        title: "Sales flow",
        projectId,
        version: 1,
        updatedAt: expect.any(String),
        url: `${ORIGIN}/diagrams/${diagramId}`,
        usedIn: [
          {
            docId: doc.docId,
            docTitle: "Plan",
            tabId: tab.tabId,
            tabTitle: "Plan",
            url: `${ORIGIN}/d/${doc.docId}/${tab.tabId}`,
          },
        ],
      },
    ]);
    // The list never carries a diagram's source.
    expect(JSON.stringify(all.body)).not.toContain("mxGraphModel");
    const unfiled = await mcp.tool("list_drawio", { noProject: true });
    expect(unfiled.body.diagrams.map((d: { diagramId: string }) => d.diagramId)).toEqual([
      loose.body.diagramId,
    ]);
    expect((await mcp.tool("list_drawio", { projectId: "nope" })).body.error).toBe("not_found");

    // Someone who only reads the doc manages no diagram.
    const reader = await agentOf(mcp, "reader@example.com", doc.docId);
    expect((await reader("list_drawio", {})).body.diagrams).toEqual([]);
  });

  it("reads a diagram by id or link, with its XML only when asked", async () => {
    const { mcp, projectId, doc, tab, diagramId } = await setup();
    await link(mcp, tab.tabId, diagramId);

    const read = await mcp.tool("read_drawio", { diagramId });
    expect(read.body).toEqual({
      diagramId,
      title: "Sales flow",
      projectId,
      version: 1,
      updatedAt: expect.any(String),
      url: `${ORIGIN}/diagrams/${diagramId}`,
      project: { projectId, key: expect.any(String), name: "Acme" },
      canEdit: true,
      usedIn: [expect.objectContaining({ docId: doc.docId, tabId: tab.tabId })],
      shapes: ["Discovery call", "Proposal"],
      connections: ["Discovery call -[won]-> Proposal"],
      picture: expect.stringContaining("No current picture"),
    });

    for (const linked of [
      `${ORIGIN}/diagrams/${diagramId}`,
      `${ORIGIN}/diagrams/${diagramId}?from=doc`,
      `/api/diagrams/${diagramId}/picture.png?v=1`,
    ]) {
      const byLink = await mcp.tool("read_drawio", { diagramId: linked, includeXml: true });
      expect(byLink.body).toMatchObject({ diagramId, xml: FLOW });
    }
    const badLink = await mcp.tool("read_drawio", { diagramId: `${ORIGIN}/d/${doc.docId}` });
    expect(badLink.body.error).toBe("invalid_argument");
    const unknown = await mcp.tool("read_drawio", { diagramId: "no-such-diagram" });
    expect(unknown).toMatchObject({ isError: true, body: { error: "not_found" } });
  });

  it("hands the agent the current picture as an image, and says when there is none", async () => {
    const { mcp, diagramId } = await setup();
    const content = async () => {
      const { result } = await mcp.rpc("tools/call", {
        name: "read_drawio",
        arguments: { diagramId },
      });
      return result!.content as unknown as Array<Record<string, string>>;
    };

    const before = await content();
    expect(before).toHaveLength(1);
    expect(JSON.parse(before[0]!.text!).picture).toContain("No current picture");

    const saved = await Diagrams.saveDiagramPicture(mcp.api.db, mcp.api.deps.images, {
      diagramId,
      version: 1,
      svg: SVG,
      png: PNG.buffer as ArrayBuffer,
    });
    expect(saved.ok).toBe(true);
    const [text, image] = await content();
    expect(JSON.parse(text!.text!).picture).toBe("Attached after this text as a PNG image.");
    expect(image).toEqual({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(PNG).toString("base64"),
    });

    // A browser that could not make a PNG stores the SVG alone.
    await Diagrams.saveDiagramPicture(mcp.api.db, mcp.api.deps.images, {
      diagramId,
      version: 1,
      svg: SVG,
      png: null,
    });
    const svgOnly = await content();
    expect(svgOnly).toHaveLength(1);
    expect(JSON.parse(svgOnly[0]!.text!).picture).toContain("No PNG of the current picture");

    // A new source leaves the stored picture behind, so it is not shown as current.
    await Diagrams.saveDiagramPicture(mcp.api.db, mcp.api.deps.images, {
      diagramId,
      version: 1,
      svg: SVG,
      png: PNG.buffer as ArrayBuffer,
    });
    const updated = await mcp.tool("update_drawio", { diagramId, xml: FLOW2, baseVersion: 1 });
    expect(updated.body.picture).toContain("No current picture");
    expect(await content()).toHaveLength(1);
  });

  it("updates a diagram against the version read, and refuses a stale write", async () => {
    const { mcp, diagramId } = await setup();
    const updated = await mcp.tool("update_drawio", { diagramId, xml: FLOW2, baseVersion: 1 });
    expect(updated.isError).toBe(false);
    expect(updated.body).toMatchObject({
      diagramId,
      version: 2,
      shapes: ["Discovery call", "Kickoff"],
      connections: ["Discovery call -> Kickoff"],
    });

    // A person saved version 2 meanwhile; the agent still holds version 1.
    const stale = await mcp.tool("update_drawio", { diagramId, xml: FLOW, baseVersion: 1 });
    expect(stale).toMatchObject({
      isError: true,
      body: { error: "version_conflict", currentVersion: 2 },
    });
    expect((await Diagrams.getDiagram(mcp.api.db, diagramId)).xml).toBe(FLOW2);

    const renamed = await mcp.tool("update_drawio", {
      diagramId,
      title: "Deal flow",
      baseVersion: 2,
    });
    expect(renamed.body).toMatchObject({ title: "Deal flow", version: 2 });
    expect(renamed.body.shapes).toEqual(["Discovery call", "Kickoff"]);
    // A rename goes by the version read too, so it never lands on a drawing the agent has not seen.
    const staleRename = await mcp.tool("update_drawio", {
      diagramId,
      title: "Old",
      baseVersion: 1,
    });
    expect(staleRename.body).toMatchObject({ error: "version_conflict", currentVersion: 2 });

    for (const args of [{ xml: FLOW }, { title: "Unversioned" }]) {
      const unversioned = await mcp.tool("update_drawio", { diagramId, ...args });
      expect(unversioned.body.error).toBe("invalid_argument");
      expect(unversioned.body.message).toContain('"baseVersion" is required');
    }
    const fractional = await mcp.tool("update_drawio", { diagramId, xml: FLOW, baseVersion: 1.5 });
    expect(fractional.body.error).toBe("invalid_argument");
    const nothing = await mcp.tool("update_drawio", { diagramId, baseVersion: 2 });
    expect(nothing.body.error).toBe("invalid_argument");
    const broken = await mcp.tool("update_drawio", { diagramId, xml: "<mxfile>", baseVersion: 2 });
    expect(broken).toMatchObject({ isError: true, body: { error: "invalid_xml" } });
    const emptied = await mcp.tool("update_drawio", { diagramId, xml: "", baseVersion: 2 });
    expect(emptied.body.error).toBe("invalid_argument");
    expect((await Diagrams.getDiagram(mcp.api.db, diagramId)).xml).toBe(FLOW2);
  });

  it("gives a reader of a linking doc the description, never the XML or a write", async () => {
    const { mcp, doc, tab, diagramId } = await setup();
    const other = await mcp.tool("create_doc", { title: "Elsewhere" });
    const stranger = await agentOf(mcp, "stranger@example.com", other.body.doc.docId, "editor");
    const reader = await agentOf(mcp, "reader@example.com", doc.docId, "editor");

    // Before the doc links it, the diagram does not exist for its reader either.
    expect((await reader("read_drawio", { diagramId })).body.error).toBe("not_found");
    await link(mcp, tab.tabId, diagramId);

    const seen = await reader("read_drawio", { diagramId });
    expect(seen.isError).toBe(false);
    expect(seen.body).toMatchObject({
      title: "Sales flow",
      canEdit: false,
      project: { name: "Acme" },
      shapes: ["Discovery call", "Proposal"],
      usedIn: [expect.objectContaining({ docId: doc.docId })],
    });
    // A project the reader is on no doc of is not named to them.
    const secret = await mcp.tool("create_drawio", {
      projectKey: "title:Secret",
      title: "Other",
      xml: FLOW2,
    });
    await mcp.tool("create_tab", {
      docId: doc.docId,
      title: "More",
      markdown: drawioBlock(secret.body.diagramId),
    });
    const fromElsewhere = await reader("read_drawio", { diagramId: secret.body.diagramId });
    expect(fromElsewhere.body).toMatchObject({ title: "Other", project: null, canEdit: false });
    expect(JSON.stringify(seen.body)).not.toContain("mxGraphModel");
    const wantsXml = await reader("read_drawio", { diagramId, includeXml: true });
    expect(wantsXml).toMatchObject({ isError: true, body: { error: "forbidden" } });
    expect(JSON.stringify(wantsXml.body)).not.toContain("mxGraphModel");
    const write = await reader("update_drawio", { diagramId, xml: FLOW2, baseVersion: 1 });
    expect(write).toMatchObject({ isError: true, body: { error: "forbidden" } });
    const rename = await reader("update_drawio", {
      diagramId,
      title: "Mine now",
      baseVersion: 1,
    });
    expect(rename).toMatchObject({ isError: true, body: { error: "forbidden" } });

    for (const [name, args] of [
      ["read_drawio", { diagramId }],
      ["read_drawio", { diagramId, includeXml: true }],
      ["update_drawio", { diagramId, xml: FLOW2, baseVersion: 1 }],
    ] as const) {
      expect((await stranger(name, args)).body.error).toBe("not_found");
    }
    expect(await Diagrams.getDiagram(mcp.api.db, diagramId)).toMatchObject({
      title: "Sales flow",
      xml: FLOW,
      version: 1,
    });

    // The reader's own diagram is theirs to change, and the admin manages it too.
    const own = await reader("create_drawio", { title: "Mine", xml: FLOW });
    expect(own.isError).toBe(false);
    const mine = await reader("update_drawio", {
      diagramId: own.body.diagramId,
      xml: FLOW2,
      baseVersion: 1,
    });
    expect(mine.body.version).toBe(2);
    expect((await stranger("read_drawio", { diagramId: own.body.diagramId })).isError).toBe(true);
    const asAdmin = await mcp.tool("read_drawio", {
      diagramId: own.body.diagramId,
      includeXml: true,
    });
    expect(asAdmin.body).toMatchObject({ canEdit: true, xml: FLOW2 });
  });
});

describe("Draw.io diagrams in docs over MCP", () => {
  it("describes each linked diagram in read_doc, beside markdown left as written", async () => {
    const { mcp, doc, tab, diagramId } = await setup();
    await link(mcp, tab.tabId, diagramId);
    const markdown = `Intro\n\n${drawioBlock(diagramId, "How a deal moves")}`;
    const second = await mcp.tool("create_tab", {
      docId: doc.docId,
      title: "Notes",
      markdown: `Same again:\n\n${drawioBlock(diagramId)}\n`,
    });
    expect(second.isError).toBe(false);
    const described = {
      diagramId,
      title: "Sales flow",
      url: `${ORIGIN}/diagrams/${diagramId}`,
      canEdit: true,
      shapes: ["Discovery call", "Proposal"],
      connections: ["Discovery call -[won]-> Proposal"],
    };

    const whole = await mcp.tool("read_doc", { docId: doc.docId });
    expect(whole.body.tabs[0].markdown).toBe(markdown);
    // Linked from two tabs, described once.
    expect(whole.body.drawioDiagrams).toEqual([described]);
    const one = await mcp.tool("read_doc", { docId: doc.docId, tabId: tab.tabId });
    expect(one.body.tab.markdown).toBe(markdown);
    expect(one.body.drawioDiagrams).toEqual([described]);
    expect(JSON.stringify(whole.body)).not.toContain("mxGraphModel");

    // A reader of the doc gets the same description; the diagram is not theirs to change.
    const reader = await agentOf(mcp, "reader@example.com", doc.docId);
    const asReader = await reader("read_doc", { docId: doc.docId });
    expect(asReader.body.drawioDiagrams).toEqual([{ ...described, canEdit: false }]);

    // An edit that matches the markdown as read still applies.
    const edit = await mcp.tool("edit_tab", {
      tabId: tab.tabId,
      find: `${diagramId}\nHow a deal moves`,
      replace: `${diagramId}\nHow a deal is won`,
    });
    expect(edit.isError).toBe(false);

    await Diagrams.deleteDiagram(mcp.api.db, mcp.api.deps.images, diagramId);
    const after = await mcp.tool("read_doc", { docId: doc.docId, tabId: tab.tabId });
    expect(after.body.drawioDiagrams).toEqual([
      { diagramId, missing: expect.stringContaining("No diagram has this id any more") },
    ]);
    const plain = await mcp.tool("create_doc", { title: "No diagrams", markdown: "Text" });
    const read = await mcp.tool("read_doc", { docId: plain.body.doc.docId });
    expect(read.body).not.toHaveProperty("drawioDiagrams");
  });

  it("keeps read_doc short when a doc links many diagrams or a large one", async () => {
    const { mcp, doc, tab } = await setup();
    const ids: Array<string> = [];
    for (let index = 0; index < 14; index += 1) {
      const created = await mcp.tool("create_drawio", { title: `D${index}`, xml: FLOW });
      ids.push(created.body.diagramId);
    }
    const cells = Array.from({ length: 50 }, (_, index) => box(`s${index}`, `Step ${index}`));
    const large = await mcp.tool("create_drawio", { title: "Large", xml: model(cells.join("")) });
    const blocks = [large.body.diagramId, ...ids].map((id) => drawioBlock(id)).join("\n\n");
    const written = await mcp.tool("edit_tab", {
      tabId: tab.tabId,
      find: "Intro",
      replace: blocks,
    });
    expect(written.isError).toBe(false);

    const read = await mcp.tool("read_doc", { docId: doc.docId });
    expect(read.body.drawioDiagrams).toHaveLength(12);
    expect(read.body.drawioDiagrams[0].shapes).toHaveLength(30);
    expect(read.body.drawioDiagrams[0].truncated).toBe(
      "20 more shapes and 0 more connections are left out to keep this short.",
    );
    expect(read.body.moreDrawioDiagrams.diagramIds).toEqual(ids.slice(11));
    // read_drawio has room for all of it.
    const full = await mcp.tool("read_drawio", { diagramId: large.body.diagramId });
    expect(full.body.shapes).toHaveLength(50);
  });

  it("refuses a write whose block is malformed or links a diagram the person cannot see", async () => {
    const { mcp, doc, tab, diagramId } = await setup();
    const other = await mcp.tool("create_doc", { title: "Theirs", markdown: "Start" });
    const otherTab = other.body.tab.tabId as string;
    const editor = await agentOf(mcp, "editor@example.com", other.body.doc.docId, "editor");

    const malformed = "```t3-drawio\nnot an id!\n```";
    const ghost = drawioBlock("00000000-0000-4000-8000-000000000000");
    const hidden = drawioBlock(diagramId);
    const writes = (block: string) => [
      editor("edit_tab", { tabId: otherTab, find: "Start", replace: block }),
      editor("write_tab", { tabId: otherTab, markdown: block, baseVersion: 2 }),
      editor("create_tab", { docId: other.body.doc.docId, title: "T", markdown: block }),
      editor("create_doc", { title: "D", markdown: block }),
    ];
    for (const result of await Promise.all(writes(malformed))) {
      expect(result).toMatchObject({ isError: true, body: { error: "drawio_invalid" } });
      expect(result.body.message).toContain("Nothing was written.");
    }
    // A diagram that does not exist and one the person cannot see read the same.
    for (const block of [ghost, hidden]) {
      for (const result of await Promise.all(writes(block))) {
        expect(result).toMatchObject({ isError: true, body: { error: "drawio_not_found" } });
        expect(result.body.message).toContain("from list_drawio or create_drawio");
      }
    }
    expect(await Docs.getTabMarkdown(mcp.api.db, otherTab)).toBe("Start");
    // So linking a diagram's id never opens it to someone it was not shared with.
    expect((await editor("read_drawio", { diagramId })).body.error).toBe("not_found");

    // Their own diagram links, and so does one they can see through another doc.
    const own = await editor("create_drawio", { title: "Mine", xml: FLOW });
    const linkedOwn = await editor("edit_tab", {
      tabId: otherTab,
      find: "Start",
      replace: `Start\n\n${drawioBlock(own.body.diagramId)}`,
    });
    expect(linkedOwn.isError).toBe(false);
    await link(mcp, tab.tabId, diagramId);
    await mcp.tool("share_doc", { docId: doc.docId, email: "editor@example.com", role: "viewer" });
    const linkedSeen = await editor("edit_tab", {
      tabId: otherTab,
      find: "Start",
      replace: `Start\n\n${hidden}`,
    });
    expect(linkedSeen.isError).toBe(false);

    // A block that was already there never blocks a later edit, even once its diagram is gone.
    await Diagrams.deleteDiagram(mcp.api.db, mcp.api.deps.images, own.body.diagramId);
    const later = await editor("edit_tab", { tabId: otherTab, find: "Start", replace: "Begin" });
    expect(later.isError).toBe(false);
    const tooMany = Array.from({ length: 21 }, (_, index) => drawioBlock(`d${index}`)).join("\n\n");
    const flood = await editor("create_tab", {
      docId: other.body.doc.docId,
      title: "Many",
      markdown: tooMany,
    });
    expect(flood).toMatchObject({ isError: true, body: { error: "too_many_diagrams" } });
  });
});
