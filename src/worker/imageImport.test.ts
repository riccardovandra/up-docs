import { describe, expect, it } from "vitest";

import { handleApi } from "./api.ts";
import * as Docs from "./docs.ts";
import {
  findImageLinks,
  importMarkdownImages,
  isFetchableHost,
  MAX_IMPORTS_PER_WRITE,
  sniffImageType,
} from "./imageImport.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2,
]);
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1,
]);
const SHOT = "https://lh7-rt.googleusercontent.com/docsz/AD_4nX-shot?key=abc";
const OWN_SRC = /^\/api\/images\/[\w-]+\/[0-9a-f-]{36}\.png$/;

const png = () =>
  new Response(PNG, { headers: { "Content-Type": "image/png" } });

describe("findImageLinks", () => {
  it("finds https image destinations, with or without brackets and titles", () => {
    const markdown = [
      "Intro ![Chart](https://a.example/c.png) text",
      '![Shot|480](<https://b.example/s s.png> "Title")',
      "![ours](/api/images/doc/x.png) ![plain](http://c.example/p.png)",
    ].join("\n");
    const links = findImageLinks(markdown);
    expect(links.map((link) => link.url)).toEqual([
      "https://a.example/c.png",
      "https://b.example/s s.png",
    ]);
    for (const link of links) {
      expect(markdown.slice(link.start, link.end)).toMatch(/^<?https:/);
    }
  });

  it("skips fenced blocks and inline code", () => {
    const markdown = [
      "```md",
      "![a](https://a.example/a.png)",
      "```",
      "`![b](https://b.example/b.png)` and ![c](https://c.example/c.png)",
      "~~~~",
      "![d](https://d.example/d.png)",
      "~~~",
      "still fenced ![e](https://e.example/e.png)",
      "~~~~",
      "![f](https://f.example/f.png)",
    ].join("\n");
    expect(findImageLinks(markdown).map((link) => link.url)).toEqual([
      "https://c.example/c.png",
      "https://f.example/f.png",
    ]);
  });
});

describe("isFetchableHost", () => {
  const own = new Set(["docs.test"]);
  it.each([
    ["images.example.com", true],
    ["lh7-rt.googleusercontent.com", true],
    ["127.0.0.1", false],
    ["2130706433", false],
    ["0x7f000001", false],
    ["[::1]", false],
    ["localhost", false],
    ["printer.local", false],
    ["metadata.internal", false],
    ["intranet", false],
    ["docs.test", false],
    ["DOCS.TEST.", false],
  ])("%s -> %s", (host, expected) => {
    expect(isFetchableHost(host, own)).toBe(expected);
  });
});

describe("sniffImageType", () => {
  it("names the type from the bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

describe("importing image links", () => {
  it("copies a link once per doc and serves the copy", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc("Text");
    // Google serves some images as octet-stream; the bytes decide the type.
    mcp.api.remote.set(
      SHOT,
      () => new Response(PNG, { headers: { "Content-Type": "binary/x" } }),
    );

    const first = await mcp.tool("import_image", {
      docId: doc.docId,
      url: SHOT,
      alt: "Dash",
    });
    expect(first.isError).toBe(false);
    expect(first.body.src).toMatch(OWN_SRC);
    expect(first.body.markdown).toBe(`![Dash](${first.body.src})`);
    const again = await mcp.tool("import_image", {
      docId: doc.docId,
      url: SHOT,
    });
    expect(again.body.src).toBe(first.body.src);
    expect(
      mcp.api.fetched.filter((request) => request.url === SHOT),
    ).toHaveLength(1);

    const served = await mcp.api.call("GET", first.body.src, {
      headers: { Cookie: mcp.cookie },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
  });

  it("refuses non-images, blocked hosts and redirects to them", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc("Text");
    mcp.api.remote.set(
      "https://site.example/page.png",
      () => new Response("<html>"),
    );
    mcp.api.remote.set(
      "https://site.example/hop.png",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://127.0.0.1/x.png" },
        }),
    );
    const cases: Array<[string, string]> = [
      ["https://site.example/page.png", "not_an_image"],
      ["https://site.example/missing.png", "download_failed"],
      ["https://site.example/hop.png", "download_failed"],
      ["https://10.0.0.1/x.png", "blocked_host"],
      [`${ORIGIN}/api/images/x/y.png`, "blocked_host"],
      ["http://site.example/x.png", "invalid_url"],
    ];
    for (const [url, error] of cases) {
      const result = await mcp.tool("import_image", { docId: doc.docId, url });
      expect(result, url).toMatchObject({ isError: true, body: { error } });
    }
    expect(
      mcp.api.fetched.some((request) => request.url.includes("127.0.0.1")),
    ).toBe(false);
  });

  it("needs the editor role", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc("Text");
    await mcp.tool("share_doc", {
      docId: doc.docId,
      email: "viewer@example.com",
      role: "viewer",
    });
    const asViewer = await mcp.asUser("viewer@example.com");
    mcp.api.remote.set(SHOT, png);
    expect(
      (await asViewer("import_image", { docId: doc.docId, url: SHOT })).isError,
    ).toBe(true);
    expect(
      (await asViewer("prepare_image_upload", { docId: doc.docId })).isError,
    ).toBe(true);
    expect(mcp.api.fetched).toHaveLength(0);
  });
});

describe("image links in agent writes", () => {
  it("saves copies for write_tab and reports a failed link", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc("Old");
    mcp.api.remote.set(SHOT, png);
    const read = await mcp.tool("read_doc", {
      docId: doc.docId,
      tabId: tab.tabId,
    });
    const written = await mcp.tool("write_tab", {
      tabId: tab.tabId,
      baseVersion: read.body.tab.version,
      markdown: `![Dash|480](${SHOT})\n\nAgain ![Dash](${SHOT}) and ![Gone](https://site.example/gone.png)\n\n\`\`\`md\n![Kept](${SHOT})\n\`\`\`\n`,
    });
    expect(written.isError).toBe(false);
    const src = written.body.images.imported[0].src as string;
    expect(src).toMatch(OWN_SRC);
    expect(written.body.images.failed).toMatchObject([
      { url: "https://site.example/gone.png", error: "download_failed" },
    ]);
    expect(await Docs.getTabMarkdown(mcp.api.db, tab.tabId)).toBe(
      `![Dash|480](${src})\n\nAgain ![Dash](${src}) and ![Gone](https://site.example/gone.png)\n\n\`\`\`md\n![Kept](${SHOT})\n\`\`\`\n`,
    );
  });

  it("copies links in create_doc, create_tab and edit_tab, and leaves plain writes alone", async () => {
    const mcp = await makeMcpHarness();
    mcp.api.remote.set(SHOT, png);
    const project = await mcp.tool("create_project", { name: "Acme" });
    const created = await mcp.tool("create_doc", {
      projectId: project.body.projectId,
      title: "Plan",
      markdown: `![a](${SHOT})\n`,
    });
    expect(created.body.images.imported).toHaveLength(1);
    const docId = created.body.doc.docId as string;
    expect(
      await Docs.getTabMarkdown(mcp.api.db, created.body.tab.tabId),
    ).toMatch(/^!\[a\]\(\/api\/images\//);

    const tab = await mcp.tool("create_tab", {
      docId,
      title: "Two",
      markdown: `![b](${SHOT})`,
    });
    expect(tab.body.images.imported).toHaveLength(1);

    const edit = await mcp.tool("edit_tab", {
      tabId: tab.body.tab.tabId,
      find: "![b]",
      replace: `![c](${SHOT}) ![b]`,
    });
    expect(edit.body.images.imported[0].src).toBe(
      tab.body.images.imported[0].src,
    );
    const plain = await mcp.tool("edit_tab", {
      tabId: tab.body.tab.tabId,
      find: "![c]",
      replace: "![d]",
    });
    expect(plain.body.images).toBeUndefined();
    // One link, one download, however many writes name it.
    expect(
      mcp.api.fetched.filter((request) => request.url === SHOT),
    ).toHaveLength(1);
  });

  it("imports at most the per-write limit and reports the rest", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc("Text");
    const links = Array.from(
      { length: MAX_IMPORTS_PER_WRITE + 2 },
      (_, i) => `https://img.example/${i}.png`,
    );
    for (const link of links) mcp.api.remote.set(link, png);
    const result = await importMarkdownImages(
      { ...mcp.api.deps, ownHosts: new Set(["docs.test"]) },
      {
        docId: doc.docId,
        markdown: links.map((link) => `![x](${link})`).join("\n"),
      },
    );
    expect(result.report!.imported).toHaveLength(MAX_IMPORTS_PER_WRITE);
    expect(result.report!.failed.map((entry) => entry.error)).toEqual([
      "over_limit",
      "over_limit",
    ]);
    expect(result.markdown.split("\n").at(-1)).toBe(`![x](${links.at(-1)})`);
  });
});

describe("agent upload links", () => {
  /** Sends a file the way curl does: no cookie, no Origin, just the link. */
  const uploader =
    (deps: Parameters<typeof handleApi>[1]) =>
    (url: string, body: BodyInit, type = "image/png") =>
      handleApi(
        new Request(url, {
          method: "PUT",
          headers: { "Content-Type": type },
          body,
        }),
        deps,
      );

  it("takes one file once, and lets a refused file retry", async () => {
    const mcp = await makeMcpHarness();
    const upload = uploader(mcp.api.deps);
    const { doc } = await mcp.seedDoc("Text");
    const prepared = await mcp.tool("prepare_image_upload", {
      docId: doc.docId,
    });
    expect(prepared.isError).toBe(false);
    const link = prepared.body.uploadUrl as string;
    expect(link).toMatch(
      new RegExp(`^${ORIGIN}/api/image-uploads/[\\w-]{40,}$`),
    );
    expect(prepared.body.curl).toContain(link);

    const wrong = await upload(
      link,
      new TextEncoder().encode("<html>"),
      "image/png",
    );
    expect(wrong.status).toBe(400);
    const sent = await upload(link, PNG);
    expect(sent.status).toBe(201);
    const body = (await sent.json()) as { url: string; markdown: string };
    expect(body.url).toMatch(OWN_SRC);
    expect(body.url.split("/")[3]).toBe(doc.docId);
    expect(body.markdown).toBe(`![](${body.url})`);
    expect((await upload(link, PNG)).status).toBe(404);
  });

  it("refuses an expired link, an unknown one, and one whose user lost edit rights", async () => {
    const mcp = await makeMcpHarness();
    const upload = uploader(mcp.api.deps);
    const { doc } = await mcp.seedDoc("Text");
    expect(
      (await upload(`${ORIGIN}/api/image-uploads/${"x".repeat(43)}`, PNG))
        .status,
    ).toBe(404);

    const expiring = await mcp.tool("prepare_image_upload", {
      docId: doc.docId,
    });
    mcp.api.clock.now += 11 * 60 * 1000;
    expect((await upload(expiring.body.uploadUrl, PNG)).status).toBe(404);

    await mcp.tool("share_doc", {
      docId: doc.docId,
      email: "ed@example.com",
      role: "editor",
    });
    const asEditor = await mcp.asUser("ed@example.com");
    const prepared = await asEditor("prepare_image_upload", {
      docId: doc.docId,
    });
    await mcp.tool("unshare_doc", {
      docId: doc.docId,
      email: "ed@example.com",
    });
    expect((await upload(prepared.body.uploadUrl, PNG)).status).toBe(403);
  });
});

describe("editor link import", () => {
  it("copies a pasted link for an editor", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc("Text");
    mcp.api.remote.set(SHOT, png);
    const response = await mcp.api.call(
      "POST",
      `/api/docs/${doc.docId}/images/import`,
      {
        body: { url: SHOT },
        headers: { Cookie: mcp.cookie },
      },
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { url: string }).url).toMatch(OWN_SRC);
    const bad = await mcp.api.call(
      "POST",
      `/api/docs/${doc.docId}/images/import`,
      {
        body: { url: "https://localhost/x.png" },
        headers: { Cookie: mcp.cookie },
      },
    );
    expect(bad.status).toBe(422);
  });
});
