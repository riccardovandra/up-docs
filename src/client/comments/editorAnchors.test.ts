import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { describe, expect, it } from "vitest";

import { findQuote, markdownToText } from "../../shared/anchors.ts";
import { createEditorExtensions } from "../editor/extensions.ts";
import { buildDocTextIndex, captureDocAnchor, resolveDocAnchor } from "./editorAnchors.ts";

const extensions = createEditorExtensions();
const schema = getSchema(extensions);
const markdown = new MarkdownManager({ extensions });
const parse = (source: string) => schema.nodeFromJSON(markdown.parse(source));

describe("editor anchors", () => {
  it("matches the Worker's text around a rich table, leaving its JSON out", () => {
    const source =
      'Before.\n\n```t3-table\n{"id":"t","columns":[{"id":"a","name":"A","type":"text"}],"rows":[]}\n```\n\nAfter.\n';
    expect(buildDocTextIndex(parse(source)).text).toBe(markdownToText(source));
    expect(markdownToText(source)).toBe("Before.\nAfter.");
  });

  it("round-trips a selection across blocks", () => {
    const index = buildDocTextIndex(parse("Intro line\n\nThe plan ships Friday.\n"));
    expect(index.text).toBe("Intro line\nThe plan ships Friday.");
    const from = index.positions[index.text.indexOf("line")]!;
    const to = index.positions[index.text.indexOf("plan") + 3]! + 1;
    const anchor = captureDocAnchor(index, from, to);
    expect(anchor?.quote).toBe("line\nThe plan");
    expect(resolveDocAnchor(index, anchor!)).toEqual({ from, to });
  });

  it("follows a passage moved, edited or removed in the editor", () => {
    const before = buildDocTextIndex(parse("Intro.\n\nTeams reach 500 by the end of Q4.\n"));
    const from = before.positions[before.text.indexOf("500")]!;
    const anchor = captureDocAnchor(before, from, from + 3)!;

    const moved = buildDocTextIndex(
      parse("# New\n\nIntro.\n\nTeams reach 500 by the end of Q4.\n"),
    );
    const movedRange = resolveDocAnchor(moved, anchor)!;
    expect(moved.text[moved.positions.indexOf(movedRange.from)]).toBe("5");

    const edited = buildDocTextIndex(parse("Intro.\n\nTeams reach 750 by the end of Q4.\n"));
    const editedRange = resolveDocAnchor(edited, anchor)!;
    expect(edited.text.slice(edited.positions.indexOf(editedRange.from))).toMatch(/^750/);

    expect(resolveDocAnchor(buildDocTextIndex(parse("Something else.\n")), anchor)).toBeNull();
  });

  it("sees the same text as the Worker, so agent quotes anchor in the editor", () => {
    const source = [
      "# Plan",
      "",
      "Ship **v1** by *Friday*, see [the brief](https://x.test) and `code`.",
      "",
      "- [ ] first task",
      "- second",
      "",
      "1. numbered item",
      "",
      "> quoted line",
      "",
      "| A | B |",
      "| --- | --- |",
      "| one | two |",
      "",
      "```mermaid",
      "graph TD",
      "  A --> B",
      "```",
      "",
    ].join("\n");
    const index = buildDocTextIndex(parse(source));
    expect(index.text).toBe(markdownToText(source));

    const match = findQuote(markdownToText(source), "**v1** by *Friday*");
    expect(match.kind).toBe("found");
    if (match.kind === "found") expect(resolveDocAnchor(index, match.anchor)).not.toBeNull();
  });
});
