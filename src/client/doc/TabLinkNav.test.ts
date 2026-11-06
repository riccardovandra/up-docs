import { describe, expect, it } from "vitest";

import { tabHeadings, wordCount } from "./TabLinkNav.tsx";

describe("tab link preview", () => {
  it("lists headings up to level 3, skipping code fences", () => {
    const markdown = "# One\ntext\n## Two ##\n```\n# not a heading\n```\n#### Four\n### Three";
    expect(tabHeadings(markdown)).toEqual(["One", "Two", "Three"]);
  });

  it("stops at six headings", () => {
    expect(tabHeadings(Array.from({ length: 9 }, (_, i) => `## H${i}`).join("\n"))).toHaveLength(6);
  });

  it("counts words, not markdown symbols", () => {
    expect(wordCount("# Title\n\n- one two\n---\n")).toBe(3);
  });
});
