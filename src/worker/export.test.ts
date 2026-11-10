import { describe, expect, it } from "vitest";

import { drawioBlock } from "../shared/drawio.ts";
import type { DocWithTabs, Tab } from "../shared/protocol.ts";
import { docMarkdown, slugify, tabMarkdown } from "./export.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

const tab = (
  id: string,
  parentTabId: string | null,
  position: number,
  title: string,
  markdown = "",
): Tab => ({
  id,
  docId: "doc",
  parentTabId,
  position,
  title,
  markdown,
  version: 1,
  updatedAt: 0,
});

const doc = (tabs: Array<Tab>): DocWithTabs => ({
  doc: {
    id: "doc",
    projectId: "p",
    title: "Doc",
    status: "thinking",
    group: null,
    createdAt: 0,
    updatedAt: 0,
  },
  tabs,
});

describe("markdown assembly", () => {
  it("shows videos as links, with uploaded files made absolute", () => {
    const file = "00000000-0000-4000-8000-000000000000.mp4";
    const body = `\`\`\`t3-video\n/api/videos/doc/${file}\nDemo\n\`\`\``;
    const expected = `[Demo](https://docs.test/api/videos/doc/${file})`;
    expect(tabMarkdown(tab("a", null, 0, "One", body), "https://docs.test")).toContain(expected);
    const whole = docMarkdown(doc([tab("a", null, 0, "One", body)]), "https://docs.test");
    expect(whole).toContain(expected);
    expect(whole).not.toContain("t3-video");
  });

  it("shows embeds as links to the post", () => {
    const body = "```t3-embed\nhttps://twitter.com/jack/status/20\nFirst post\n```";
    const markdown = tabMarkdown(tab("a", null, 0, "One", body), "https://docs.test");
    expect(markdown).toContain("[First post](https://x.com/jack/status/20)");
    expect(markdown).not.toContain("t3-embed");
  });

  it("shows linked Draw.io diagrams as their pictures, with the caption", () => {
    const diagrams = new Map([
      ["g1", { id: "g1", title: "Onboarding", pictureVersion: 1, hasSource: true }],
    ]);
    const body = `Intro\n\n${drawioBlock("g1", "How a client starts")}`;
    const expected =
      "![Onboarding](https://docs.test/api/diagrams/g1/picture.svg)\n\nHow a client starts";
    const one = tabMarkdown(tab("a", null, 0, "One", body), "https://docs.test", diagrams);
    expect(one).toBe(`# One\n\nIntro\n\n${expected}\n`);
    const whole = docMarkdown(doc([tab("a", null, 0, "One", body)]), "https://docs.test", diagrams);
    expect(whole).toContain(expected);
    expect(whole).not.toContain("t3-drawio");
  });

  it("leaves a linked diagram's block alone when the caller has no diagrams to show", () => {
    const body = drawioBlock("g1");
    expect(tabMarkdown(tab("a", null, 0, "One", body), "https://docs.test")).toContain(body);
  });

  it("writes tabs depth-first with heading levels that follow depth", () => {
    const markdown = docMarkdown(
      doc([
        tab("b", null, 1, "Second", "Two"),
        tab("a2", "a", 1, "Child 2", "A2"),
        tab("a", null, 0, "First", "One\n"),
        tab("a1", "a", 0, "Child 1", "A1"),
        tab("deep", "a1", 0, "Grandchild", "G"),
      ]),
    );
    expect(markdown).toBe(
      [
        "# First\n\nOne\n",
        "## Child 1\n\nA1\n",
        "### Grandchild\n\nG\n",
        "## Child 2\n\nA2\n",
        "# Second\n\nTwo\n",
      ].join("\n"),
    );
  });

  it("does not repeat a title the tab already opens with", () => {
    const markdown = docMarkdown(
      doc([
        tab("a", null, 0, "Repo overlap analysis", "\n  # repo Overlap Analysis  \n\nBody"),
        tab("b", null, 1, "Risks", "## Risks ##\n\nR"),
        tab("c", null, 2, "Plan", "# Planning\n\nP"),
        tab("d", null, 3, "Notes", "Notes\n\n# Notes"),
      ]),
    );
    expect(markdown).toBe(
      [
        "# repo Overlap Analysis  \n\nBody\n",
        "## Risks ##\n\nR\n",
        "# Plan\n\n# Planning\n\nP\n",
        "# Notes\n\nNotes\n\n# Notes\n",
      ].join("\n"),
    );
  });

  it("keeps empty tabs as a bare heading and caps the level at six", () => {
    const chain = Array.from({ length: 8 }, (_, depth) =>
      tab(`t${depth}`, depth === 0 ? null : `t${depth - 1}`, 0, `Level ${depth}`),
    );
    const lines = docMarkdown(doc(chain)).split("\n").filter(Boolean);
    expect(lines[0]).toBe("# Level 0");
    expect(lines.at(-1)).toBe("###### Level 7");
    expect(lines).toHaveLength(8);
    expect(tabMarkdown(tab("x", "p", 0, "Empty", "  \n"))).toBe("# Empty\n");
  });

  it("slugifies titles into safe filenames", () => {
    expect(slugify("Q4 Plan: Docs / Cloud!")).toBe("q4-plan-docs-cloud");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify('"quoted"; name')).toBe("quoted-name");
    expect(slugify("日本語")).toBe("untitled");
    expect(slugify("a".repeat(200))).toHaveLength(80);
  });
});

describe("rich tables in exports", () => {
  it("render as GFM tables so the download reads without the app", () => {
    const json = JSON.stringify({
      id: "t1",
      columns: [
        { id: "a", name: "Request", type: "text" },
        { id: "s", name: "Status", type: "select", options: [{ value: "Done", color: "green" }] },
      ],
      rows: [{ id: "r1", cells: { a: "Ship", s: "Done" } }],
    });
    const markdown = `Intro\n\n\`\`\`t3-table\n${json}\n\`\`\`\n`;
    expect(tabMarkdown(tab("a", null, 0, "Plan", markdown))).toBe(
      "# Plan\n\nIntro\n\n| Request | Status |\n| --- | --- |\n| Ship | Done |\n",
    );
  });
});

describe("export routes", () => {
  async function seed(api: ReturnType<typeof makeApiHarness>, cookie: string) {
    const headers = { Cookie: cookie };
    const project = await api.call("POST", "/api/projects", { body: { name: "P" }, headers });
    const { project: created } = (await project.json()) as { project: { id: string } };
    const docResponse = await api.call("POST", "/api/docs", {
      body: { projectId: created.id, title: "Launch Plan" },
      headers,
    });
    const seeded = (await docResponse.json()) as DocWithTabs;
    const root = seeded.tabs[0]!;
    await api.call("PATCH", `/api/tabs/${root.id}`, {
      body: { baseVersion: 1, markdown: "Intro" },
      headers,
    });
    const child = await api.call("POST", `/api/docs/${seeded.doc.id}/tabs`, {
      body: { title: "Risks", parentTabId: root.id, markdown: "- none" },
      headers,
    });
    return { docId: seeded.doc.id, childId: ((await child.json()) as { tab: Tab }).tab.id };
  }

  it("downloads a whole doc and a single tab as markdown attachments", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { docId, childId } = await seed(api, cookie);

    const whole = await api.call("GET", `/api/docs/${docId}/export.md`, {
      headers: { Cookie: cookie },
    });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(whole.headers.get("Content-Disposition")).toBe('attachment; filename="launch-plan.md"');
    expect(await whole.text()).toBe("# Launch Plan\n\nIntro\n\n## Risks\n\n- none\n");

    const one = await api.call("GET", `/api/tabs/${childId}/export.md`, {
      headers: { Cookie: cookie },
    });
    expect(one.headers.get("Content-Disposition")).toBe('attachment; filename="risks.md"');
    expect(await one.text()).toBe("# Risks\n\n- none\n");
  });

  it("requires a session or token and 404s on unknown ids", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const { docId, childId } = await seed(api, cookie);

    expect((await api.call("GET", `/api/docs/${docId}/export.md`)).status).toBe(401);
    expect((await api.call("GET", `/api/tabs/${childId}/export.md`)).status).toBe(401);

    const created = await api.call("POST", "/api/tokens", {
      body: { name: "agent" },
      headers: { Cookie: cookie },
    });
    const { token } = (await created.json()) as { token: string };
    const bearer = await api.call("GET", `/api/docs/${docId}/export.md`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bearer.status).toBe(200);

    const missing = await api.call("GET", "/api/docs/nope/export.md", {
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
    const missingTab = await api.call("GET", "/api/tabs/nope/export.md", {
      headers: { Cookie: cookie },
    });
    expect(missingTab.status).toBe(404);
  });

  it("exports a linked diagram as its picture, a note when there is none, and says when it is gone", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    const headers = { Cookie: cookie };
    const { docId } = await seed(api, cookie);
    const create = async (title: string, xml = "<mxGraphModel/>") =>
      (
        (await (
          await api.call("POST", "/api/diagrams", { body: { title, xml }, headers })
        ).json()) as { diagram: { id: string } }
      ).diagram.id;
    const drawn = await create("Drawn");
    const undrawn = await create("Undrawn");
    const empty = await create("Empty", "");
    const gone = await create("Gone");
    await api.call("PUT", `/api/diagrams/${drawn}/picture`, {
      body: { version: 1, svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', png: null },
      headers,
    });
    const added = await api.call("POST", `/api/docs/${docId}/tabs`, {
      body: {
        title: "Flows",
        markdown: [
          drawioBlock(drawn, "Step by step"),
          drawioBlock(undrawn),
          drawioBlock(empty),
          drawioBlock(gone, "Old flow"),
        ].join("\n\n"),
      },
      headers,
    });
    const { tab: flows } = (await added.json()) as { tab: Tab };
    expect((await api.call("DELETE", `/api/diagrams/${gone}`, { headers })).status).toBe(200);

    const expected = [
      `![Drawn](https://docs.test/api/diagrams/${drawn}/picture.svg)`,
      "Step by step",
      `[Undrawn](https://docs.test/diagrams/${undrawn}) (Diagram: its picture has not been drawn yet.)`,
      `[Empty](https://docs.test/diagrams/${empty}) (Diagram: nothing has been drawn in it yet.)`,
      "*Diagram not found.*",
      "Old flow",
    ].join("\n\n");
    const one = await api.call("GET", `/api/tabs/${flows.id}/export.md`, { headers });
    expect(one.status).toBe(200);
    expect(await one.text()).toBe(`# Flows\n\n${expected}\n`);
    const whole = await (await api.call("GET", `/api/docs/${docId}/export.md`, { headers })).text();
    expect(whole).toContain(expected);
    expect(whole).not.toContain("t3-drawio");

    // The picture the export points at is one a reader of the doc can load.
    await api.call("POST", `/api/docs/${docId}/members`, {
      body: { email: "reader@example.com", role: "viewer" },
      headers,
    });
    const reader = await api.signIn("reader@example.com");
    const asReader = { headers: { Cookie: reader } };
    expect((await api.call("GET", `/api/tabs/${flows.id}/export.md`, asReader)).status).toBe(200);
    const picture = await api.call("GET", `/api/diagrams/${drawn}/picture.svg`, asReader);
    expect(picture.status).toBe(200);
  });
});
