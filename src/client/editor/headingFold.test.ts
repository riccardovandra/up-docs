import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { createEditorExtensions } from "./extensions.ts";
import {
  foldPlugin,
  foldedKeys,
  foldedRanges,
  headingSections,
  toggleFold,
  visiblePos,
} from "./headingFold.ts";

const extensions = createEditorExtensions();
const schema = getSchema(extensions);
const markdown = new MarkdownManager({ extensions });
const parse = (source: string) => schema.nodeFromJSON(markdown.parse(source));
const stateOf = (source: string) =>
  EditorState.create({ schema, doc: parse(source), plugins: [foldPlugin()] });

const DOC = "# A\n\nIntro.\n\n## B\n\nBody.\n\n### C\n\nDeep.\n\n## D\n\nMore.\n\n# E\n\nEnd.";

/** Text of the top-level blocks a fold hides. */
const hiddenText = (state: EditorState) => {
  const ranges = foldedRanges(headingSections(state.doc), foldedKeys(state));
  const hidden: Array<string> = [];
  state.doc.forEach((node, pos) => {
    if (ranges.some((range) => pos >= range.from && pos < range.to)) hidden.push(node.textContent);
  });
  return hidden;
};

describe("headingSections", () => {
  it("ends a section at the next heading of the same or a higher level", () => {
    const doc = parse(DOC);
    const sections = headingSections(doc);
    const keyAt = (pos: number) => sections.find((section) => section.pos === pos)?.key;
    expect(sections.map((section) => [section.key, keyAt(section.end) ?? "end"])).toEqual([
      ["1:A", "1:E"],
      ["2:B", "2:D"],
      ["3:C", "2:D"],
      ["2:D", "1:E"],
      ["1:E", "end"],
    ]);
  });

  it("keys repeated headings by occurrence", () => {
    const keys = headingSections(parse("## Notes\n\nOne.\n\n## Notes\n\nTwo.")).map((s) => s.key);
    expect(keys).toEqual(["2:Notes", "2:Notes#1"]);
  });
});

describe("folding", () => {
  it("hides a section's body and its subsections, not the heading", () => {
    const state = stateOf(DOC);
    const folded = state.apply(toggleFold(state, "2:B"));
    expect(hiddenText(folded)).toEqual(["Body.", "C", "Deep."]);
    expect(hiddenText(folded.apply(toggleFold(folded, "2:B")))).toEqual([]);
  });

  it("keeps a fold nested inside a folded section once the outer one opens", () => {
    let state = stateOf(DOC);
    state = state.apply(toggleFold(state, "3:C"));
    state = state.apply(toggleFold(state, "1:A"));
    expect(hiddenText(state)).toEqual(["Intro.", "B", "Body.", "C", "Deep.", "D", "More."]);
    state = state.apply(toggleFold(state, "1:A"));
    expect(hiddenText(state)).toEqual(["Deep."]);
  });

  it("keeps a heading folded while its text is retyped", () => {
    let state = stateOf(DOC);
    state = state.apply(toggleFold(state, "2:B"));
    const b = headingSections(state.doc).find((section) => section.key === "2:B")!;
    state = state.apply(state.tr.insertText("ee", b.bodyStart - 1));
    expect([...foldedKeys(state)]).toEqual(["2:Bee"]);
    expect(hiddenText(state)).toEqual(["Body.", "C", "Deep."]);
  });

  it("keeps a fold when the whole tab is replaced by a remote write", () => {
    let state = stateOf(DOC);
    state = state.apply(toggleFold(state, "2:D"));
    const remote = parse(`Preface.\n\n${DOC}`);
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, remote.content));
    expect(hiddenText(state)).toEqual(["More."]);
  });

  it("moves a caret that the fold would hide onto the heading", () => {
    let state = stateOf(DOC);
    const b = headingSections(state.doc).find((section) => section.key === "2:B")!;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, b.bodyStart + 2)));
    state = state.apply(toggleFold(state, "2:B"));
    expect(state.selection.from).toBe(b.bodyStart - 1);
  });

  it("places hidden positions at their folded heading", () => {
    let state = stateOf(DOC);
    state = state.apply(toggleFold(state, "2:B"));
    const b = headingSections(state.doc).find((section) => section.key === "2:B")!;
    expect(visiblePos(state, b.bodyStart + 2)).toBe(b.pos);
    expect(visiblePos(state, 2)).toBe(2);
  });
});
