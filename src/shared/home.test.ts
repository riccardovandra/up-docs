import { describe, expect, it } from "vitest";

import { docPreview, PREVIEW_LENGTH, searchSnippet } from "./home.ts";

describe("docPreview", () => {
  it("keeps prose and headings, dropping a heading that repeats the title", () => {
    const markdown = [
      "# Launch plan",
      "",
      "We ship **on Friday**, with [notes](https://x.test).",
      "Second line of the same paragraph.",
      "",
      "## Risks",
      "- Late `QA`",
      "> Quoted text",
    ].join("\n");
    expect(docPreview(markdown, "Launch Plan")).toBe(
      [
        "We ship on Friday, with notes. Second line of the same paragraph.",
        "# Risks",
        "Late QA",
        "Quoted text",
      ].join("\n"),
    );
  });

  it("keeps a first heading that differs from the title", () => {
    expect(docPreview("# Mission\n\nText", "Signature")).toBe("# Mission\nText");
  });

  it("skips code, diagrams, rich tables, GFM tables, images and rules", () => {
    const markdown = [
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "```t3-table",
      '{"rows":[]}',
      "```",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "![chart](https://x.test/c.png)",
      "---",
      "Only this.",
    ].join("\n");
    expect(docPreview(markdown, "Doc")).toBe("Only this.");
  });

  it("caps the text at a word boundary with an ellipsis", () => {
    const preview = docPreview("alpha ".repeat(400), "Doc");
    expect(preview.endsWith("alpha…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_LENGTH + 1);
  });

  it("is empty for an empty tab", () => {
    expect(docPreview("", "Doc")).toBe("");
  });
});

describe("searchSnippet", () => {
  it("centres on the match and marks cut edges", () => {
    const before = "lead ".repeat(40);
    const after = " tail".repeat(60);
    const snippet = searchSnippet(`${before}the Needle here${after}`, "needle");
    expect(snippet!.startsWith("…")).toBe(true);
    expect(snippet!.endsWith("…")).toBe(true);
    expect(snippet).toContain("the Needle here");
    expect(snippet!.length).toBeLessThan(200);
  });

  it("is null when the visible text does not hold the match", () => {
    expect(searchSnippet("a needle", "needle")).toBe("a needle");
    expect(searchSnippet("a haystack", "needle")).toBeNull();
  });
});
