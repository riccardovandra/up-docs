import * as NodeFS from "node:fs";

import { describe, expect, it } from "vitest";

import { findWidgetFences } from "../widget/fence.ts";
import { FLOW_EXAMPLE, PILLARS_EXAMPLE } from "../widget/testing/examples.ts";
import {
  birthName,
  convertMarkdown,
  prepareClaudeDocPush,
  widgetCaption,
  widgetHash,
  type ClaudeDocLink,
  type SourceTab,
} from "./toClaudeDoc.ts";

const ORIGIN = "https://docs.test";
const CLAUDE_DOC = "8904ac93-5d1d-47ed-b397-426fc6a75888";

// A diagram whose svg has no aria-label, so its caption comes from the title text.
const UNLABELLED = `export default () => <svg viewBox='0 0 760 80' role='img'>
  <text data-claude-text-id='title' x='24' y='34' fontSize='15' fill='var(--cds-text-primary)'>Signups doubled in March</text>
</svg>;`;

const PIPE_TABLE = `| Work                  | Status      | Stage it serves |
| --------------------- | ----------- | --------------- |
| Gateway with two ads  | Live        | 1a, 1b, 1c      |
| Guardrails (\`svc-*\`)  | In progress | 1c, and every 2 |`;

/**
 * Shaped like the real source tab: a title, blank lines, bold lead-ins, two
 * multi-line diagrams with prose around them, padded pipe tables and a list.
 */
const SOURCE = `# Platform roadmap: toward an autonomous market



**North star:** an agent that runs a small market on its own.

## From manual to autonomous

The work is the same at every stage.

\`\`\`t3-widget id=release-flow
${FLOW_EXAMPLE}
\`\`\`

A person can already report, propose and act.

## Where we are


${PIPE_TABLE}


## The components it needs

Every call passes down through layers.

\`\`\`t3-widget id=pillars
${PILLARS_EXAMPLE}
\`\`\`

Only the bottom layer is live today.

1. One identity for reporting (for example \`svc-report\`).
2. A way to sign in. See [the guide](https://example.com/guide).

**To decide:** which channels.`;

const tab = (markdown: string, overrides: Partial<SourceTab> = {}): SourceTab => ({
  id: "tab-1",
  docId: "doc-1",
  title: "Roadmap",
  version: 7,
  markdown,
  ...overrides,
});

const prepare = (markdown: string, link: ClaudeDocLink | null = null, extra = {}) =>
  prepareClaudeDocPush({
    tab: tab(markdown),
    claudeDocId: CLAUDE_DOC,
    link,
    origin: ORIGIN,
    ...extra,
  });

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("convertMarkdown on a tab shaped like the source tab", () => {
  it("puts one token per diagram on its own paragraph and keeps everything else", async () => {
    const pushed = await prepare(SOURCE);
    const { markdown, blocks } = pushed.content;
    expect(count(markdown, "<?claude block w1?>")).toBe(1);
    expect(count(markdown, "<?claude block w2?>")).toBe(1);
    expect(markdown).toContain("stage.\n\n<?claude block w1?>\n\nA person");
    expect(markdown).not.toContain("t3-widget");
    expect(markdown).toContain(PIPE_TABLE);
    // Only the fences changed.
    const fences = findWidgetFences(SOURCE);
    let expected = SOURCE;
    fences.forEach((fence, index) => {
      expected = expected.replace(
        "```t3-widget id=" + fence.id + "\n" + fence.source + "\n```",
        `<?claude block w${index + 1}?>`,
      );
    });
    expect(markdown).toBe(expected);
    expect(pushed.warnings).toEqual([]);
    expect(blocks).toEqual({
      w1: { type: "embed", ref: "node/$lid:w1", caption: "Only a green build reaches production" },
      w2: {
        type: "embed",
        ref: "node/$lid:w2",
        caption: "Three pillars carry the goal of doubling active teams",
      },
    });
    expect(pushed.widgets.map((widget) => [widget.key, widget.slug])).toEqual([
      ["w1", "release-flow"],
      ["w2", "pillars"],
    ]);
    expect(pushed.widgets[0]!.code).toBe(fences[0]!.source);
    expect(pushed.widgets[0]!.code).toBe(FLOW_EXAMPLE);
  });

  it("separates a token from text the fence was touching", () => {
    const { markdown } = convertMarkdown(
      "Before\n```t3-widget id=a\n" + FLOW_EXAMPLE + "\n```\nAfter",
      ORIGIN,
    );
    expect(markdown).toBe("Before\n\n<?claude block w1?>\n\nAfter");
  });
});

describe("conversion rules", () => {
  it("flattens a t3-table to GFM with a warning naming it", () => {
    const table = {
      id: "requests",
      columns: [
        { id: "req", name: "Request", type: "text" },
        { id: "ticket", name: "Ticket", type: "link" },
      ],
      rows: [
        {
          id: "r1",
          cells: { req: "Fix it", ticket: { text: "TASK-1", url: "https://example.com/1" } },
        },
      ],
    };
    const result = convertMarkdown(
      "Intro\n\n```t3-table\n" + JSON.stringify(table) + "\n```\n",
      ORIGIN,
    );
    expect(result.markdown).toBe(
      "Intro\n\n| Request | Ticket |\n| --- | --- |\n| Fix it | [TASK-1](https://example.com/1) |\n",
    );
    expect(result.warnings).toEqual([{ kind: "table-flattened", detail: "requests" }]);
  });

  it("turns videos and embeds into links, keeps mermaid, drops uploaded images", () => {
    const result = convertMarkdown(
      [
        "```t3-video\nhttps://youtu.be/dQw4w9WgXcQ\nWalkthrough\n```",
        "```t3-embed\nhttps://example.com/post\nA post\n```",
        "```mermaid\ngraph TD; A-->B\n```",
        "Look: ![Chart|480](/api/images/00000000-0000-4000-8000-000000000000/a.png) and ![Remote](https://example.com/x.png)",
      ].join("\n\n"),
      ORIGIN,
    );
    expect(result.markdown).toBe(
      [
        "[Walkthrough](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
        "[A post](https://example.com/post)",
        "```mermaid\ngraph TD; A-->B\n```",
        "Look: _[image: Chart]_ and ![Remote](https://example.com/x.png)",
      ].join("\n\n"),
    );
    expect(result.warnings.map((warning) => warning.kind)).toEqual([
      "video-as-link",
      "embed-as-link",
      "mermaid-as-code",
      "image-dropped",
    ]);
    expect(result.warnings[3]!.detail).toBe("Chart");
  });

  it("escapes a literal <?claude in the text", () => {
    const result = convertMarkdown("Write <?claude block x?> to place a block.", ORIGIN);
    expect(result.markdown).toBe("Write \\<?claude block x?> to place a block.");
    expect(result.warnings.map((warning) => warning.kind)).toEqual(["claude-token-in-text"]);
  });

  it("refuses diagrams that share an id", async () => {
    const fence = "```t3-widget id=same\n" + FLOW_EXAMPLE + "\n```";
    await expect(prepare(`${fence}\n\n${fence}`)).rejects.toThrow(/share the id "same"/);
  });

  it("captions from the aria-label, else the title text, else the slug", () => {
    expect(widgetCaption(FLOW_EXAMPLE, "x")).toBe("Only a green build reaches production");
    expect(widgetCaption(UNLABELLED, "x")).toBe("Signups doubled in March");
    expect(widgetCaption("export default () => <svg viewBox='0 0 760 80'/>;", "slug")).toBe("slug");
  });

  it("names the file without slashes or control characters", () => {
    expect(birthName(" Plan / Q4\u0007 ")).toBe("Plan  Q4.ldoc");
    expect(birthName("///")).toBe("Untitled.ldoc");
    expect(birthName("x".repeat(300))).toBe(`${"x".repeat(255)}.ldoc`);
  });

  it("hashes widget code to 16 stable hex characters", async () => {
    const hash = await widgetHash(FLOW_EXAMPLE);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await widgetHash(FLOW_EXAMPLE)).toBe(hash);
    expect(await widgetHash(UNLABELLED)).not.toBe(hash);
  });
});

describe("mode new", () => {
  it("builds the batch members in order and shape", async () => {
    const markdown = "Intro\n\n```t3-widget id=flow\n" + FLOW_EXAMPLE + "\n```\n";
    const pushed = await prepare(markdown, null, { tabName: "Client / view", order: "W0" });
    expect(pushed.mode).toBe("new");
    expect(pushed.link).toBeNull();
    expect(pushed.widgetCreates).toBeUndefined();
    expect(pushed.tab).toEqual({ tabId: "tab-1", docId: "doc-1", title: "Roadmap", version: 7 });
    const blocks = {
      w1: { type: "embed", ref: "node/$lid:w1", caption: "Only a green build reaches production" },
    };
    expect(pushed.batch).toEqual([
      {
        $lid: "f",
        verb: "create",
        object: "file",
        payload: { value: { birthName: "Client  view.ldoc" } },
      },
      {
        $lid: "w1",
        verb: "create",
        object: "node",
        engine: "widget",
        payload: { parent: { object: "file", id: "$lid:f" }, code: FLOW_EXAMPLE },
      },
      {
        $lid: "n",
        verb: "create",
        object: "node",
        engine: "prose",
        payload: {
          parent: { object: "file", id: "$lid:f" },
          source: {
            as: "markdown",
            blocks,
            from: { kind: "inline", content: "Intro\n\n<?claude block w1?>\n" },
          },
        },
      },
      {
        verb: "update",
        ref: { object: "file", id: "$lid:f" },
        payload: {
          kind: "value",
          value: { birthName: "Client  view.ldoc", content: { kind: "node", id: "$lid:n" } },
        },
      },
      {
        verb: "update",
        ref: { object: "project", id: CLAUDE_DOC },
        payload: {
          kind: "patch",
          patch: [
            { op: "set", path: ["tabs", "$lid:f"], value: { name: "Client / view", order: "W0" } },
          ],
        },
      },
    ]);
    // Key order is part of the contract S2 reads.
    expect(Object.keys(pushed.batch![2]!)).toEqual(["$lid", "verb", "object", "engine", "payload"]);
  });

  it("omits prose blocks when there are no diagrams and defaults name and order", async () => {
    const pushed = await prepare("Just text.");
    expect(pushed.batch).toHaveLength(4);
    const prose = pushed.batch![1] as { payload: { source: Record<string, unknown> } };
    expect(prose.payload.source).toEqual({
      as: "markdown",
      from: { kind: "inline", content: "Just text." },
    });
    expect(pushed.batch![0]).toMatchObject({ payload: { value: { birthName: "Roadmap.ldoc" } } });
    expect(pushed.batch![3]).toMatchObject({
      payload: { patch: [{ value: { name: "Roadmap", order: "z0" } }] },
    });
  });
});

describe("mode update", () => {
  it("reuses linked nodes, marks changed widgets and lists removed ones", async () => {
    const markdown = [
      "```t3-widget id=flow\n" + FLOW_EXAMPLE + "\n```",
      "```t3-widget id=pillars\n" + PILLARS_EXAMPLE + "\n```",
      "```t3-widget id=fresh\n" + UNLABELLED + "\n```",
    ].join("\n\n");
    const link: ClaudeDocLink = {
      claudeDocId: CLAUDE_DOC,
      claudeDocUrl: "https://claude.ai/artifact/abc",
      claudeTabId: "file-9",
      claudeBodyId: "node-body",
      widgetMap: {
        flow: { nodeId: "node-flow", hash: await widgetHash(FLOW_EXAMPLE), pub: 4 },
        pillars: { nodeId: "node-pillars", hash: "0000000000000000" },
        gone: { nodeId: "node-gone", hash: "1111111111111111" },
      },
      pushedVersion: 3,
      pushedRev: 2,
      pushedAt: "2026-11-05T10:00:00.000Z",
    };
    const pushed = await prepare(markdown, link);
    expect(pushed.mode).toBe("update");
    expect(pushed.batch).toBeUndefined();
    expect(pushed.link).toEqual(link);
    expect(
      pushed.widgets.map(({ key, slug, nodeId, changed }) => ({ key, slug, nodeId, changed })),
    ).toEqual([
      { key: "w1", slug: "flow", nodeId: "node-flow", changed: false },
      { key: "w2", slug: "pillars", nodeId: "node-pillars", changed: true },
      { key: "w3", slug: "fresh", nodeId: null, changed: true },
    ]);
    expect(Object.values(pushed.content.blocks).map((block) => block.ref)).toEqual([
      "node/node-flow",
      "node/node-pillars",
      "node/$lid:w3",
    ]);
    expect(pushed.removedWidgets).toEqual([{ slug: "gone", nodeId: "node-gone" }]);
    expect(pushed.widgetCreates).toEqual([
      {
        $lid: "w3",
        verb: "create",
        object: "node",
        engine: "widget",
        payload: { parent: { object: "file", id: "file-9" }, code: UNLABELLED },
      },
    ]);
  });
});

// The real source tab is client material, so it stays out of this public
// repo. Point CLAUDE_SYNC_SOURCE_TAB at its JSON ({ markdown }) to run this.
const realTabPath = process.env.CLAUDE_SYNC_SOURCE_TAB;
describe.skipIf(!realTabPath)("the real source tab", () => {
  it("keeps diagrams byte for byte, captions them and leaves pipe tables alone", async () => {
    const { markdown } = JSON.parse(NodeFS.readFileSync(realTabPath!, "utf8")) as {
      markdown: string;
    };
    const pushed = await prepare(markdown);
    expect(count(pushed.content.markdown, "<?claude block w1?>")).toBe(1);
    const fences = findWidgetFences(markdown);
    expect(pushed.widgets.map((widget) => widget.code)).toEqual(
      fences.map((fence) => fence.source),
    );
    expect(pushed.widgets[1]!.caption).toBe(
      "An autonomous market agent sits on four layers Bark controls",
    );
    const pipeTables = markdown.match(/^\|.*\|$(?:\n^\|.*\|$)+/gm) ?? [];
    expect(pipeTables.length).toBeGreaterThan(0);
    for (const table of pipeTables) expect(pushed.content.markdown).toContain(table);
    expect(pushed.warnings).toEqual([]);
  });
});
