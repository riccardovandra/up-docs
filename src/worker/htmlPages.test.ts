import { describe, expect, it } from "vitest";

import {
  checkPagesIn,
  looksLikeHtml,
  MAX_PAGE_BYTES,
  pageBlock,
  pageIdsIn,
  pagesToLinks,
  parsePageBlock,
  type PageListItem,
  type PageView,
} from "../shared/htmlPages.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { handleApi } from "./api.ts";
import { d1ImageStore } from "./images.ts";
import * as HtmlPages from "./htmlPages.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";
import { makeTestD1 } from "./testing/sqliteD1.ts";

/** A small dummy page: a button that runs script, and two hash views. */
const PAGE = `<!doctype html><html><head><title>Dummy</title></head><body>
<nav><a href="#one">One</a> <a href="#two">Two</a></nav>
<section id="one">First view</section><section id="two">Second view</section>
<button onclick="this.textContent='clicked'">Click</button>
</body></html>`;
const PAGE2 = PAGE.replace("First view", "First view, changed");

const FRAME = { "Sec-Fetch-Dest": "iframe" };

async function setup() {
  const api = makeApiHarness({ frameAncestors: ["https://app.t3.codes"] });
  const admin = await api.signIn();
  const send = async <A>(
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie, ...headers } });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Page HTML and plain-text refusals are not JSON.
    }
    return { status: response.status, headers: response.headers, body: parsed as A };
  };
  /** Uploads raw HTML (a string body, not JSON). */
  const upload = async (cookie: string, path: string, html: string | Uint8Array<ArrayBuffer>) => {
    const request = new Request(`https://docs.test${path}`, {
      method: "POST",
      headers: { Origin: "https://docs.test", Cookie: cookie, "Content-Type": "text/html" },
      body: html,
    });
    const reply = await handleApi(request, api.deps);
    return { status: reply.status, body: (await reply.json()) as { page: PageView; error?: string } };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const newDoc = async (title: string) =>
    (await send<DocWithTabs>(admin, "POST", "/api/docs", { projectId: project.id, title })).body;
  const doc = await newDoc("Playbook");
  const person = async (email: string, docId: string, role = "viewer") => {
    await send(admin, "POST", `/api/docs/${docId}/members`, { email, role });
    return api.signIn(email);
  };
  const embed = async (target: DocWithTabs, pageId: string, by = admin) => {
    const tab = target.tabs[0]!;
    const current = (await send<{ tab: { version: number } }>(by, "GET", `/api/tabs/${tab.id}`)).body
      .tab;
    const written = await send(by, "PATCH", `/api/tabs/${tab.id}`, {
      baseVersion: current.version,
      markdown: `Intro\n\n${pageBlock(pageId, "The model")}\n`,
    });
    expect(written.status).toBe(200);
  };
  return { api, admin, project, doc, newDoc, person, send, upload, embed };
}

describe("page block", () => {
  it("reads an id, an optional height and an optional caption", () => {
    expect(parsePageBlock("abc")).toEqual({ pageId: "abc", height: null, caption: null });
    expect(parsePageBlock("abc\nheight: 900\nThe model")).toEqual({
      pageId: "abc",
      height: 900,
      caption: "The model",
    });
    expect(parsePageBlock("abc\nheight: 50")).toBeNull();
    expect(parsePageBlock("not an id!")).toBeNull();
    expect(parsePageBlock("abc\ncaption\nextra")).toBeNull();
  });

  it("checks only blocks a write adds or changes, and lists embedded ids", () => {
    const good = `${pageBlock("p1")}\n\n${pageBlock("p2", "Two")}`;
    expect(checkPagesIn(good)).toBeNull();
    expect(pageIdsIn(good)).toEqual(["p1", "p2"]);
    const bad = "```t3-page\n!!\n```";
    expect(checkPagesIn(bad)).toMatch(/first line must be the id of a page/);
    expect(checkPagesIn(bad, bad)).toBeNull();
  });

  it("turns blocks into links for downloads", () => {
    expect(pagesToLinks(pageBlock("p1", "Model"), "https://docs.test")).toBe(
      "[Model](https://docs.test/pages/p1)",
    );
  });

  it("tells HTML from other files", () => {
    expect(looksLikeHtml(PAGE)).toBe(true);
    expect(looksLikeHtml("﻿<!-- note -->\n<html><body></body></html>")).toBe(true);
    expect(looksLikeHtml("hello")).toBe(false);
    expect(looksLikeHtml("<svg></svg>")).toBe(false);
  });
});

describe("pages over the API", () => {
  it("creates a page, lists it for its creator, and serves its HTML sandboxed into a frame", async () => {
    const { admin, project, send, upload } = await setup();
    const created = await upload(admin, `/api/pages?title=Model&projectId=${project.id}`, PAGE);
    expect(created.status).toBe(201);
    const page = created.body.page;
    expect(page).toMatchObject({ title: "Model", projectId: project.id, version: 1, role: "owner" });
    expect(page.versions).toHaveLength(1);

    const listed = await send<{ pages: Array<PageListItem> }>(admin, "GET", "/api/pages");
    expect(listed.body.pages.map((each) => each.id)).toEqual([page.id]);
    expect(listed.body.pages[0]!.bytes).toBe(new TextEncoder().encode(PAGE).byteLength);

    const content = await send<string>(admin, "GET", `/api/pages/${page.id}/versions/1/content`, undefined, FRAME);
    expect(content.status).toBe(200);
    expect(content.body).toBe(PAGE);
    const csp = content.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toContain("frame-ancestors 'self' https://app.t3.codes");
    expect(content.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(content.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(content.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses the HTML outside a frame", async () => {
    const { admin, upload, send } = await setup();
    const { page } = (await upload(admin, "/api/pages?title=Model", PAGE)).body;
    const tab = await send<string>(admin, "GET", `/api/pages/${page.id}/versions/1/content`, undefined, {
      "Sec-Fetch-Dest": "document",
    });
    expect(tab.status).toBe(403);
    const none = await send<string>(admin, "GET", `/api/pages/${page.id}/versions/1/content`);
    expect(none.status).toBe(403);
    // The download is an attachment, and sandboxed even if a browser showed it.
    const saved = await send<string>(admin, "GET", `/api/pages/${page.id}/versions/1/download`);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("Content-Disposition")).toBe('attachment; filename="Model-v1.html"');
    expect(saved.headers.get("Content-Security-Policy")).toMatch(/^sandbox allow-scripts /);
    expect(saved.body).toBe(PAGE);
  });

  it("keeps every version readable and moves the current one forward", async () => {
    const { admin, upload, send } = await setup();
    const { page } = (await upload(admin, "/api/pages?title=Model", PAGE)).body;
    const next = await upload(admin, `/api/pages/${page.id}/versions?note=Second`, PAGE2);
    expect(next.status).toBe(201);
    expect(next.body.page.version).toBe(2);
    expect(next.body.page.versions.map((each) => [each.version, each.note])).toEqual([
      [2, "Second"],
      [1, null],
    ]);
    const first = await send<string>(admin, "GET", `/api/pages/${page.id}/versions/1/content`, undefined, FRAME);
    const second = await send<string>(admin, "GET", `/api/pages/${page.id}/versions/2/content`, undefined, FRAME);
    expect(first.body).toBe(PAGE);
    expect(second.body).toBe(PAGE2);
    const missing = await send(admin, "GET", `/api/pages/${page.id}/versions/3/content`, undefined, FRAME);
    expect(missing.status).toBe(404);
  });

  it("refuses files that are not HTML or are too large", async () => {
    const { admin, upload } = await setup();
    const text = await upload(admin, "/api/pages?title=Notes", "just words");
    expect(text.status).toBe(400);
    expect(text.body.error).toBe("invalid_html");
    const binary = await upload(admin, "/api/pages?title=Bin", new Uint8Array([0xff, 0xfe, 0x00, 0x3c]));
    expect(binary.status).toBe(400);
    const big = `<!doctype html>${"x".repeat(MAX_PAGE_BYTES)}`;
    const large = await upload(admin, "/api/pages?title=Big", big);
    expect(large.status).toBe(413);
  });

  it("keeps a page private until it is shared, then lets a viewer read but not change it", async () => {
    const { admin, doc, person, send, upload } = await setup();
    const { page } = (await upload(admin, "/api/pages?title=Model", PAGE)).body;
    const guest = await person("guest@example.com", doc.doc.id);
    expect((await send(guest, "GET", `/api/pages/${page.id}`)).status).toBe(404);
    expect((await send(guest, "GET", `/api/pages/${page.id}/versions/1/content`, undefined, FRAME)).status).toBe(404);
    expect((await send<{ pages: [] }>(guest, "GET", "/api/pages")).body.pages).toEqual([]);

    const shared = await send(admin, "POST", `/api/pages/${page.id}/members`, {
      email: "guest@example.com",
      role: "viewer",
    });
    expect(shared.status).toBe(201);
    const seen = await send<{ page: PageView }>(guest, "GET", `/api/pages/${page.id}`);
    expect(seen.body.page).toMatchObject({ role: "viewer", member: true, canEdit: false });
    expect((await send(guest, "GET", `/api/pages/${page.id}/versions/1/content`, undefined, FRAME)).status).toBe(200);
    expect((await upload(guest, `/api/pages/${page.id}/versions`, PAGE2)).status).toBe(403);
    expect((await send(guest, "PATCH", `/api/pages/${page.id}`, { title: "Mine" })).status).toBe(403);
    expect((await send(guest, "DELETE", `/api/pages/${page.id}`)).status).toBe(403);
  });

  it("emails an invite with the page link, and lets a page-only person sign in", async () => {
    const { api, admin, send, upload } = await setup();
    const { page } = (await upload(admin, "/api/pages?title=Model", PAGE)).body;
    await send(admin, "POST", `/api/pages/${page.id}/members`, {
      email: "client@example.com",
      role: "viewer",
    });
    expect(api.invites.at(-1)).toMatchObject({
      to: "client@example.com",
      docTitle: "Model",
      url: `https://docs.test/pages/${page.id}`,
    });
    const client = await api.signIn("client@example.com");
    expect((await send(client, "GET", `/api/pages/${page.id}`)).status).toBe(200);
  });

  it("shows an embedded page to a doc's readers when a page editor edits that doc", async () => {
    const { doc, newDoc, person, send, upload, embed } = await setup();
    const creator = await person("creator@example.com", doc.doc.id, "editor");
    const { page } = (await upload(creator, "/api/pages?title=Model", PAGE)).body;
    const reader = await person("reader@example.com", doc.doc.id);
    await embed(doc, page.id, creator);
    const seen = await send<{ page: PageView }>(reader, "GET", `/api/pages/${page.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.page).toMatchObject({ role: "viewer", member: false });
    // Not on the page's own list: the list and sharing stay closed.
    expect((await send(reader, "GET", `/api/pages/${page.id}/members`)).status).toBe(404);

    // An editor of another doc who was never given the page pastes its id: nothing shows
    // (that doc's owner, the admin, is not on the page's list either).
    const other = await newDoc("Elsewhere");
    const editor = await person("editor@example.com", other.doc.id, "editor");
    const otherReader = await person("other@example.com", other.doc.id);
    await embed(other, page.id, editor);
    expect((await send(otherReader, "GET", `/api/pages/${page.id}`)).status).toBe(404);
  });

  it("renames, moves and deletes a page, removing its stored files", async () => {
    const { api, admin, project, send, upload } = await setup();
    const { page } = (await upload(admin, `/api/pages?title=Model&projectId=${project.id}`, PAGE)).body;
    const renamed = await send<{ page: PageView }>(admin, "PATCH", `/api/pages/${page.id}`, {
      title: "Model v2",
      projectId: null,
    });
    expect(renamed.body.page).toMatchObject({ title: "Model v2", projectId: null });
    expect([...api.images.keys()].some((key) => key.startsWith(`pages/${page.id}/`))).toBe(true);
    expect((await send(admin, "DELETE", `/api/pages/${page.id}`)).status).toBe(200);
    expect([...api.images.keys()].some((key) => key.startsWith(`pages/${page.id}/`))).toBe(false);
    expect((await send(admin, "GET", `/api/pages/${page.id}`)).status).toBe(404);
  });
});

describe("page storage without R2", () => {
  it("keeps HTML in page_chunks", async () => {
    const db = makeTestD1();
    const store = d1ImageStore(db);
    await db
      .prepare("INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'u1@example.com', '', 1)")
      .run();
    const html = new TextEncoder().encode(PAGE).buffer as ArrayBuffer;
    const page = await HtmlPages.createPage(db, store, {
      projectId: null,
      title: "Model",
      html,
      createdBy: "u1",
      now: 1,
    });
    const read = await HtmlPages.readPageHtml(db, store, { pageId: page.id, version: 1 });
    expect(read?.html).toBe(PAGE);
    await HtmlPages.deletePage(db, store, page.id);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM page_chunks").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
