import { describe, expect, it } from "vitest";

import { handlePageLink } from "./mcp.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

// A small dummy page: never client content in fixtures.
const page = (label: string) =>
  `<!doctype html><html><head><title>Demo</title></head><body>` +
  `<a href="#second">Second</a><section id="second">${label}</section>` +
  `<button onclick="this.textContent='clicked'">Click</button></body></html>`;

type Harness = Awaited<ReturnType<typeof makeMcpHarness>>;

const send = (mcp: Harness, url: string, method: string, body?: string) =>
  handlePageLink(new Request(url, { method, ...(body === undefined ? {} : { body }) }), mcp.api.deps).then(
    (response) => response!,
  );

async function setup() {
  const mcp = await makeMcpHarness();
  const projectId = (await mcp.tool("create_project", { name: "Acme" })).body.projectId as string;
  return { mcp, projectId };
}

async function publish(mcp: Harness, projectId: string, html = page("First")) {
  const prepared = await mcp.tool("prepare_page_upload", { title: "Prototype", projectId, note: "first cut" });
  const sent = await send(mcp, prepared.body.uploadUrl, "PUT", html);
  expect(sent.status).toBe(201);
  return (await sent.json()) as { pageId: string; url: string; block: string; version: number };
}

describe("page tools", () => {
  it("lists the page tools and ignores other API paths", async () => {
    const { mcp } = await setup();
    const list = await mcp.rpc("tools/list");
    const names = (list.result!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["prepare_page_upload", "list_pages", "read_page"]));
    expect(await handlePageLink(new Request(`${ORIGIN}/api/library`), mcp.api.deps)).toBeNull();
  });

  it("publishes a page from an uploaded file, once, and reads it back", async () => {
    const { mcp, projectId } = await setup();
    const prepared = await mcp.tool("prepare_page_upload", { title: "Prototype", projectId });
    expect(prepared.isError).toBe(false);
    expect(prepared.body.uploadUrl).toMatch(new RegExp(`^${ORIGIN}/api/page-uploads/[\\w-]{40,}$`));
    expect(prepared.body.curl).toContain(prepared.body.uploadUrl);

    // A file that is not HTML is refused with nothing saved, and the link stays usable.
    const refused = await send(mcp, prepared.body.uploadUrl, "PUT", "just text");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_html");
    expect((await mcp.tool("list_pages", {})).body.pages).toHaveLength(0);

    const sent = await send(mcp, prepared.body.uploadUrl, "PUT", page("First"));
    expect(sent.status).toBe(201);
    const created = (await sent.json()) as { pageId: string; url: string; block: string; version: number };
    expect(created.url).toBe(`${ORIGIN}/pages/${created.pageId}`);
    expect(created.block).toBe(`\`\`\`t3-page\n${created.pageId}\n\`\`\``);
    expect(created.version).toBe(1);
    expect((await send(mcp, prepared.body.uploadUrl, "PUT", page("Again"))).status).toBe(404);

    const listed = await mcp.tool("list_pages", { projectId });
    expect(listed.body.pages).toMatchObject([{ pageId: created.pageId, title: "Prototype", role: "owner" }]);
    const read = await mcp.tool("read_page", { pageId: created.url, includeHtml: true });
    expect(read.isError).toBe(false);
    expect(read.body.html).toBe(page("First"));
    expect(read.body.project.projectId).toBe(projectId);
  });

  it("adds versions by link and downloads any version once", async () => {
    const { mcp, projectId } = await setup();
    const { pageId } = await publish(mcp, projectId);
    const next = await mcp.tool("prepare_page_upload", { pageId, note: "second cut", title: "Prototype v2" });
    const sent = await send(mcp, next.body.uploadUrl, "PUT", page("Second"));
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ version: 2, title: "Prototype v2" });

    const read = await mcp.tool("read_page", { pageId, version: 1, downloadLink: true });
    expect(read.body.versions.map((entry: { version: number }) => entry.version)).toEqual([2, 1]);
    expect(read.body.versions[0].note).toBe("second cut");
    const got = await send(mcp, read.body.download.url, "GET");
    expect(got.status).toBe(200);
    expect(got.headers.get("X-Page-Version")).toBe("1");
    // A download is a file to save, never HTML that runs on the app's origin.
    expect(got.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await got.text()).toBe(page("First"));
    expect((await send(mcp, read.body.download.url, "GET")).status).toBe(404);
    expect((await mcp.tool("read_page", { pageId, version: 9 })).body.error).toBe("not_found");
  });

  it("is private until shared, and sharing goes through share_doc {pageId}", async () => {
    const { mcp, projectId } = await setup();
    const { pageId } = await publish(mcp, projectId);
    // On a doc that does not show the page, so they can sign in.
    const doc = await mcp.tool("create_doc", { projectId, title: "Plan" });
    await mcp.tool("share_doc", { docId: doc.body.doc.docId, email: "vi@example.com", role: "viewer" });
    const other = await mcp.asUser("vi@example.com");
    expect((await other("read_page", { pageId })).body.error).toBe("not_found");
    expect((await other("prepare_page_upload", { pageId })).body.error).toBe("not_found");

    const shared = await mcp.tool("share_doc", { pageId, email: "vi@example.com", role: "viewer" });
    expect(shared.isError).toBe(false);
    expect(shared.body.added).toBe(true);
    const members = await mcp.tool("list_members", { pageId });
    expect(members.body.members.map((member: { email: string }) => member.email)).toContain("vi@example.com");
    expect((await other("read_page", { pageId })).body.role).toBe("viewer");
    expect((await other("prepare_page_upload", { pageId })).body.error).toBe("forbidden");

    expect((await mcp.tool("unshare_doc", { pageId, email: "vi@example.com" })).isError).toBe(false);
    expect((await other("read_page", { pageId })).body.error).toBe("not_found");
    expect((await mcp.tool("share_doc", { pageId, docId: "x", email: "a@b.c", role: "viewer" })).body.error).toBe(
      "invalid_argument",
    );
  });

  it("checks t3-page blocks on doc writes", async () => {
    const { mcp, projectId } = await setup();
    const { pageId, block } = await publish(mcp, projectId);
    const doc = await mcp.tool("create_doc", { projectId, title: "Plan" });
    const tabId = doc.body.tab.tabId as string;
    const baseVersion = doc.body.tab.version as number;
    const bad = await mcp.tool("write_tab", { tabId, baseVersion, markdown: "```t3-page\nnot an id!\n```" });
    expect(bad.body.error).toBe("page_invalid");
    const missing = await mcp.tool("write_tab", { tabId, baseVersion, markdown: "```t3-page\nnoSuchPage\n```" });
    expect(missing.body.error).toBe("page_not_found");
    const ok = await mcp.tool("write_tab", { tabId, baseVersion, markdown: `# Plan\n\n${block}\n` });
    expect(ok.isError).toBe(false);
    const read = await mcp.tool("read_page", { pageId });
    expect(read.body.usedIn).toMatchObject([{ docId: doc.body.doc.docId, tabId }]);
  });

  it("refuses expired links and links of a revoked token", async () => {
    const { mcp, projectId } = await setup();
    const expiring = await mcp.tool("prepare_page_upload", { title: "Late", projectId });
    mcp.api.clock.now += 11 * 60 * 1000;
    expect((await send(mcp, expiring.body.uploadUrl, "PUT", page("Late"))).status).toBe(404);

    const live = await mcp.tool("prepare_page_upload", { title: "Revoked", projectId });
    const listed = await mcp.api.call("GET", "/api/tokens", { headers: { Cookie: mcp.cookie } });
    const { tokens } = (await listed.json()) as { tokens: Array<{ id: string }> };
    for (const token of tokens)
      await mcp.api.call("DELETE", `/api/tokens/${token.id}`, { headers: { Cookie: mcp.cookie } });
    expect((await send(mcp, live.body.uploadUrl, "PUT", page("Revoked"))).status).toBe(404);
    expect((await send(mcp, `${ORIGIN}/api/page-uploads/${"x".repeat(43)}`, "GET")).status).toBe(405);
  });
});
