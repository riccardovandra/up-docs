import { describe, expect, it } from "vitest";

import { docPreview, searchSnippet } from "./home.ts";
import { formatTable, type RichTable } from "./table.ts";
import { richBlockText, visibleText } from "./visibleText.ts";
import { FLOW_EXAMPLE } from "./widget/testing/examples.ts";

const table: RichTable = {
  id: "t1",
  columns: [
    { id: "n", name: "#", type: "number" },
    { id: "req", name: "Request", type: "text" },
    { id: "doc", name: "Spec", type: "link" },
  ],
  rows: [
    { id: "r1", cells: { n: 1, req: "Fix Zebra MCP issues", doc: { text: "Brief", url: "" } } },
  ],
};
const tableFence = "```t3-table\n" + formatTable(table) + "\n```";
const diagramFence = "```t3-widget id=flow\n" + FLOW_EXAMPLE + "\n```";

describe("visibleText", () => {
  it("reads rich tables as cells and diagrams as labels, keeping plain code", () => {
    const text = visibleText(
      ["Intro **bold**.", tableFence, diagramFence, "```js\nconst rows = 1;\n```", "End."].join(
        "\n\n",
      ),
    );
    expect(text).toContain("Intro bold.");
    expect(text).toContain("Request\nSpec\n1\nFix Zebra MCP issues\nBrief");
    expect(text).toContain("Ship to production");
    expect(text).toContain("const rows = 1;");
    expect(text).not.toContain('"cells"');
    expect(text).not.toContain("var(--cds");
  });

  it("gives search a snippet of what a reader sees, and none for a match in JSON or code", () => {
    const markdown = `Backlog\n\n${tableFence}\n\n${diagramFence}`;
    expect(searchSnippet(visibleText(markdown), "zebra")).toMatch(
      /^Backlog # Request Spec 1 Fix Zebra MCP issues Brief Only a green build .*…$/,
    );
    expect(searchSnippet(visibleText(markdown), "rows")).toBeNull();
    expect(searchSnippet(visibleText(markdown), "strokeWidth")).toBeNull();
  });

  it("skips a rich table that does not parse", () => {
    expect(richBlockText("t3-table", '{"rows": [')).toEqual([]);
    expect(richBlockText("mermaid", "graph TD")).toBeNull();
  });
});

describe("docPreview with rich blocks", () => {
  it("shows a table's cells and a diagram's labels near the top, never their source", () => {
    const preview = docPreview(`# Plan\n\n${tableFence}\n\n${diagramFence}`, "Plan", richBlockText);
    expect(preview.split("\n").slice(0, 6)).toEqual([
      "#",
      "Request",
      "Spec",
      "1",
      "Fix Zebra MCP issues",
      "Brief",
    ]);
    expect(preview).toContain("Ship to production");
    expect(preview).not.toMatch(/"cells"|data-claude|var\(--cds/);
  });

  it("shows nothing of a block the preview's head cuts off", () => {
    const head = `Lead.\n\n${tableFence}`.slice(0, 60);
    expect(docPreview(head, "Doc", richBlockText)).toBe("Lead.");
  });
});
