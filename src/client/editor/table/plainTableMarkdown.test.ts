import { flattenExtensions, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { describe, expect, it } from "vitest";

import { createEditorExtensions } from "../extensions.ts";
import { formatColumnWidths, parseColumnWidths } from "./plainTableMarkdown.ts";

const markdown = new MarkdownManager({ extensions: flattenExtensions(createEditorExtensions()) });

const firstTable = (doc: JSONContent) => doc.content?.find((node) => node.type === "table");
const widths = (doc: JSONContent) =>
  firstTable(doc)?.content?.map((row) => row.content?.map((cell) => cell.attrs?.colwidth ?? null));

const PLAIN = "| Area | Owner |\n| --- | --- |\n| Lead | Head of AI |";

describe("plain table widths in markdown", () => {
  it("leaves a table without widths as plain markdown", () => {
    const out = markdown.serialize(markdown.parse(`Intro.\n\n${PLAIN}\n\nAfter.`));
    expect(out).not.toContain("col-widths");
    expect(widths(markdown.parse(out))).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("reads widths onto every cell of each column", () => {
    const doc = markdown.parse(`<!-- col-widths: 120 0 -->\n${PLAIN}`);
    expect(widths(doc)).toEqual([
      [[120], null],
      [[120], null],
    ]);
  });

  it("round-trips widths byte-stable", () => {
    const source = `Intro.\n\n<!-- col-widths: 120 340 -->\n${PLAIN}\n\nAfter.`;
    const once = markdown.serialize(markdown.parse(source));
    expect(once).toContain("<!-- col-widths: 120 340 -->\n| Area");
    expect(markdown.serialize(markdown.parse(once))).toBe(once);
    expect(widths(markdown.parse(once))?.[1]).toEqual([[120], [340]]);
    expect(once).toContain("After.");
  });

  it("keeps the content around the table", () => {
    const doc = markdown.parse(`# Title\n\n<!-- col-widths: 200 200 -->\n${PLAIN}\n\nAfter.`);
    expect(doc.content?.map((node) => node.type)).toEqual(["heading", "table", "paragraph"]);
  });

  it("ignores a widths comment that has no table under it", () => {
    const doc = markdown.parse("<!-- col-widths: 120 -->\nJust text.");
    expect(firstTable(doc)).toBeUndefined();
  });
});

describe("column widths", () => {
  it("clamps and drops unusable values", () => {
    expect(parseColumnWidths("10 0 300 99999")).toEqual([60, null, 300, 2000]);
  });

  it("writes nothing when no column has a width", () => {
    expect(formatColumnWidths([null, null])).toBeNull();
    expect(formatColumnWidths([150, null])).toBe("<!-- col-widths: 150 0 -->");
  });
});
