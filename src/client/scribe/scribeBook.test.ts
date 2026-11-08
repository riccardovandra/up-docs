import { describe, expect, it } from "vitest";

import type { Tab } from "../../shared/protocol.ts";
import { formatTable, type RichTable } from "../../shared/table.ts";
import { draftScribeBook, dropTitleHeading } from "./scribeBook.ts";

const ORIGIN = "https://docs.example.com";

const tab = (
  id: string,
  title: string,
  markdown: string,
  parentTabId: string | null = null,
  position = 0,
): Tab => ({
  id,
  docId: "doc1",
  parentTabId,
  position,
  title,
  markdown,
  version: 1,
  updatedAt: 0,
});

const draft = (tabs: ReadonlyArray<Tab>) =>
  draftScribeBook({
    title: "Plan",
    author: "Ada",
    tabs,
    origin: ORIGIN,
    tabUrl: (id) => `${ORIGIN}/d/doc1/${id}`,
  });

describe("draftScribeBook", () => {
  it("makes the first tab chapter one and the rest follow in reading order", () => {
    const { book } = draft([
      tab("c", "Appendix", "c", null, 2),
      tab("b1", "Detail", "b1", "b", 0),
      tab("a", "Overview", "a", null, 0),
      tab("b", "Design", "b", null, 1),
    ]);
    expect(book.chapters.map((chapter) => [chapter.title, chapter.depth])).toEqual([
      ["Overview", 0],
      ["Design", 0],
      ["Detail", 1],
      ["Appendix", 0],
    ]);
    expect(book.chapters[2]?.sourceUrl).toBe(`${ORIGIN}/d/doc1/b1`);
    expect(book).toMatchObject({ title: "Plan", author: "Ada", language: "en" });
  });

  it("sends a nested tab on its own as a one-chapter book", () => {
    const { book } = draft([tab("b1", "Detail", "Body", "b", 3)]);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]).toMatchObject({ title: "Detail", depth: 0 });
  });

  it("keeps formatting as HTML and drops a heading that repeats the tab title", () => {
    const { book } = draft([
      tab(
        "a",
        "Overview",
        "# Overview\n\n**Bold** and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] open",
      ),
    ]);
    const html = book.chapters[0]!.html;
    expect(html).not.toContain("<h1>Overview</h1>");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<table>");
    expect(html).toContain("☑ done");
    expect(html).toContain("☐ open");
  });

  it("makes images absolute, strips the stored width and lists the doc's own images", () => {
    const { book, sameOriginImages } = draft([
      tab("a", "A", "![Chart|480](/api/images/doc1/x.png)\n\n![Logo](https://cdn.other.com/l.png)"),
    ]);
    const html = book.chapters[0]!.html;
    expect(html).toContain(`<img src="${ORIGIN}/api/images/doc1/x.png" alt="Chart">`);
    expect(html).toContain('<img src="https://cdn.other.com/l.png" alt="Logo">');
    expect(sameOriginImages).toEqual([`${ORIGIN}/api/images/doc1/x.png`]);
  });

  it("swaps diagrams for numbered images and leaves other code blocks as code", () => {
    const { book, diagrams } = draft([
      tab(
        "a",
        "A",
        "```mermaid\nflowchart LR\n  A --> B\n```\n\n```t3-widget id=loop\nexport default () => <svg />\n```\n\n```ts\nconst x = 1;\n```",
      ),
    ]);
    expect(diagrams).toEqual([
      { url: `${ORIGIN}/scribe-diagram/1.svg`, kind: "mermaid", source: "flowchart LR\n  A --> B" },
      {
        url: `${ORIGIN}/scribe-diagram/2.svg`,
        kind: "widget",
        source: "export default () => <svg />",
      },
    ]);
    const html = book.chapters[0]!.html;
    expect(html).toContain(`<img src="${ORIGIN}/scribe-diagram/1.svg" alt="Diagram">`);
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("flowchart");
  });

  it("turns rich tables into plain tables", () => {
    const rich = formatTable({
      id: "t1",
      columns: [{ id: "name", name: "Request", type: "text" }],
      rows: [{ id: "r1", cells: { name: "Alpha" } }],
    } as RichTable);
    const { book } = draft([tab("a", "A", `\`\`\`t3-table\n${rich}\n\`\`\``)]);
    const html = book.chapters[0]!.html;
    expect(html).toContain("<th>Request</th>");
    expect(html).toContain("<td>Alpha</td>");
    expect(html).not.toContain("t3-table");
  });
});

describe("dropTitleHeading", () => {
  it("drops only a leading heading that matches the title", () => {
    expect(dropTitleHeading("## Overview \n\nBody", "overview")).toBe("\nBody");
    expect(dropTitleHeading("# Other\n\nBody", "Overview")).toBe("# Other\n\nBody");
  });
});
