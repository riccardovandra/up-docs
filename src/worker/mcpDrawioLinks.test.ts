import { describe, expect, it } from "vitest";

import { handleDrawioLink } from "./mcp.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const box = (id: string, label: string) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;html=1;" vertex="1" parent="1">` +
  `<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>`;
const pages = (...names: Array<string>) =>
  `<mxfile>${names
    .map((name, i) => `<diagram name="${name}" id="p${i}">${model(box(`b${i}`, name))}</diagram>`)
    .join("")}</mxfile>`;

type Harness = Awaited<ReturnType<typeof makeMcpHarness>>;

const send = (mcp: Harness, url: string, method: string, body?: string) =>
  handleDrawioLink(new Request(url, { method, ...(body === undefined ? {} : { body }) }), mcp.api.deps).then(
    (response) => response!,
  );

async function setup() {
  const mcp = await makeMcpHarness();
  const projectId = (await mcp.tool("create_project", { name: "Acme" })).body.projectId as string;
  return { mcp, projectId };
}

describe("Draw.io upload and download links", () => {
  it("lists prepare_drawio_upload and ignores other API paths", async () => {
    const { mcp } = await setup();
    const list = await mcp.rpc("tools/list");
    const names = (list.result!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("prepare_drawio_upload");
    expect(await handleDrawioLink(new Request(`${ORIGIN}/api/library`), mcp.api.deps)).toBeNull();
  });

  it("creates a diagram from an uploaded file, once", async () => {
    const { mcp, projectId } = await setup();
    const prepared = await mcp.tool("prepare_drawio_upload", { title: "System map", projectId });
    expect(prepared.isError).toBe(false);
    expect(prepared.body.runs).toBe("create_drawio");
    expect(prepared.body.uploadUrl).toMatch(new RegExp(`^${ORIGIN}/api/diagram-uploads/[\\w-]{40,}$`));
    expect(prepared.body.curl).toContain(prepared.body.uploadUrl);

    const file = pages("Overview", "Data");
    const sent = await send(mcp, prepared.body.uploadUrl, "PUT", file);
    expect(sent.status).toBe(201);
    const created = (await sent.json()) as { diagramId: string; title: string; pageNames: Array<string>; version: number };
    expect(created.title).toBe("System map");
    expect(created.pageNames).toEqual(["Overview", "Data"]);
    expect((await mcp.tool("read_drawio", { diagramId: created.diagramId })).body.project.projectId).toBe(projectId);

    expect((await send(mcp, prepared.body.uploadUrl, "PUT", file)).status).toBe(404);
  });

  it("downloads a diagram, then replaces it by upload with the same version check", async () => {
    const { mcp, projectId } = await setup();
    const created = await mcp.tool("create_drawio", { projectId, title: "Map", xml: pages("One", "Two") });
    const diagramId = created.body.diagramId as string;

    const read = await mcp.tool("read_drawio", { diagramId, downloadLink: true });
    expect(read.isError).toBe(false);
    expect(read.body.xml).toBeUndefined();
    const got = await send(mcp, read.body.download.url, "GET");
    expect(got.status).toBe(200);
    expect(got.headers.get("X-Diagram-Version")).toBe("1");
    const file = await got.text();
    expect(file).toContain('name="Two"');
    expect((await send(mcp, read.body.download.url, "GET")).status).toBe(404);

    const stale = await mcp.tool("prepare_drawio_upload", { diagramId, baseVersion: 0 });
    expect(stale.body.error).toBe("version_conflict");
    expect(stale.body.currentVersion).toBe(1);
    expect((await mcp.tool("prepare_drawio_upload", { diagramId })).body.error).toBe("invalid_argument");

    const prepared = await mcp.tool("prepare_drawio_upload", { diagramId, baseVersion: 1, title: "Map v2" });
    expect(prepared.body.runs).toBe("update_drawio");
    // A broken file is refused with the tool's own error and leaves the link usable.
    const broken = await send(mcp, prepared.body.uploadUrl, "PUT", "<mxfile><diagram");
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: string }).error).toBeTruthy();
    // Leaving out a page goes through update_drawio's own notes.
    const sent = await send(mcp, prepared.body.uploadUrl, "PUT", pages("One", "Three"));
    expect(sent.status).toBe(200);
    const updated = (await sent.json()) as { version: number; title: string; pageNames: Array<string>; warnings?: Array<string> };
    expect(updated).toMatchObject({ version: 2, title: "Map v2", pageNames: ["One", "Three"] });
    expect(updated.warnings?.[0]).toContain('Pages deleted: "Two"');
  });

  it("refuses an upload when someone saved after the link was made, and burns that link", async () => {
    const { mcp, projectId } = await setup();
    const diagramId = (await mcp.tool("create_drawio", { projectId, title: "Map", xml: model(box("a", "A")) })).body
      .diagramId as string;
    const prepared = await mcp.tool("prepare_drawio_upload", { diagramId, baseVersion: 1 });
    expect((await mcp.tool("update_drawio", { diagramId, baseVersion: 1, xml: model(box("a", "Saved first")) })).isError).toBe(false);
    const late = await send(mcp, prepared.body.uploadUrl, "PUT", model(box("a", "B")));
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("version_conflict");
    expect((await send(mcp, prepared.body.uploadUrl, "PUT", model(box("a", "B")))).status).toBe(404);
  });

  it("keeps the rights of the token that asked: others, expired links and revoked tokens are refused", async () => {
    const { mcp, projectId } = await setup();
    const diagramId = (await mcp.tool("create_drawio", { projectId, title: "Map", xml: model(box("a", "A")) })).body
      .diagramId as string;
    const doc = await mcp.tool("create_doc", { projectId, title: "Plan" });
    await mcp.tool("share_doc", { docId: doc.body.doc.docId, email: "vi@example.com", role: "editor" });
    const other = await mcp.asUser("vi@example.com");
    // Unlinked, the diagram is not even visible to them; either way no link is made.
    expect((await other("read_drawio", { diagramId, downloadLink: true })).body.error).toMatch(/^(forbidden|not_found)$/);
    expect((await other("prepare_drawio_upload", { diagramId, baseVersion: 1 })).body.error).toMatch(/^(forbidden|not_found)$/);

    const expiring = await mcp.tool("prepare_drawio_upload", { diagramId, baseVersion: 1 });
    mcp.api.clock.now += 11 * 60 * 1000;
    expect((await send(mcp, expiring.body.uploadUrl, "PUT", model(box("a", "B")))).status).toBe(404);

    const live = await mcp.tool("prepare_drawio_upload", { diagramId, baseVersion: 1 });
    const listed = await mcp.api.call("GET", "/api/tokens", { headers: { Cookie: mcp.cookie } });
    const { tokens } = (await listed.json()) as { tokens: Array<{ id: string }> };
    for (const token of tokens)
      await mcp.api.call("DELETE", `/api/tokens/${token.id}`, { headers: { Cookie: mcp.cookie } });
    expect((await send(mcp, live.body.uploadUrl, "PUT", model(box("a", "B")))).status).toBe(404);

    expect((await send(mcp, `${ORIGIN}/api/diagram-uploads/${"x".repeat(43)}`, "GET")).status).toBe(405);
  });
});
