import { flattenExtensions, getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { createEditorExtensions } from "./extensions.ts";

const markdown = new MarkdownManager({ extensions: flattenExtensions(createEditorExtensions()) });
const roundTrip = (source: string) => markdown.serialize(markdown.parse(source));
const schema = getSchema(flattenExtensions(createEditorExtensions()));

const IMAGE = "![Chart](/api/images/d/x.png)";

describe("image markdown", () => {
  it.each([
    ["an uploaded image", "![Chart](/api/images/doc-1/0b6f3a52-6a3e-4b0c-9a55-2b1d1f4f2a10.png)"],
    ["an image inside a sentence", "Before ![a](/api/images/d/x.png) after."],
    ["a remote image, kept as written", "![logo](https://example.com/logo.png)"],
    ["a title", '![a](/api/images/d/x.png "The title")'],
    ["no alt text", "![](/api/images/d/x.png)"],
  ])("round-trips %s", (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("parses into an image node", () => {
    const images: Array<unknown> = [];
    const walk = (node: { type?: string; content?: Array<unknown> }) => {
      if (node.type === "image") images.push(node);
      for (const child of node.content ?? []) walk(child as typeof node);
    };
    walk(markdown.parse("Intro\n\n![Chart](/api/images/d/x.png)"));
    expect(images).toEqual([
      expect.objectContaining({
        type: "image",
        attrs: expect.objectContaining({ src: "/api/images/d/x.png", alt: "Chart" }),
      }),
    ]);
  });

  describe.each([
    ["alone in a doc", IMAGE],
    ["after text", `Intro\n\n${IMAGE}`],
    ["before text", `${IMAGE}\n\nOutro`],
    ["in a list item", `- ${IMAGE}`],
    ["in a task item", `- [ ] ${IMAGE}`],
    ["in a list item's second paragraph", `- Intro\n\n  ${IMAGE}`],
    ["in a blockquote", `> ${IMAGE}`],
    ["twice on one line", `${IMAGE} ${IMAGE}`],
    ["on two lines of a paragraph", `${IMAGE}\n${IMAGE}`],
    ["in consecutive paragraphs", `${IMAGE}\n\n${IMAGE}`],
  ])("%s", (_name, source) => {
    it("parses to content the schema accepts", () => {
      expect(() => schema.nodeFromJSON(markdown.parse(source)).check()).not.toThrow();
    });

    it("survives the transaction that blanked the page", () => {
      // Tiptap's trailing node plugin appends a paragraph like this on load.
      const doc = schema.nodeFromJSON(markdown.parse(source));
      const { tr } = EditorState.create({ schema, doc });
      expect(() => tr.insert(doc.content.size, schema.nodes.paragraph!.create())).not.toThrow();
    });

    it("round-trips to the same text", () => {
      expect(roundTrip(source)).toBe(source);
    });
  });

  it("keeps an image in a table cell", () => {
    const source = `| a |\n| - |\n| ${IMAGE} |`;
    expect(() => schema.nodeFromJSON(markdown.parse(source)).check()).not.toThrow();
    expect(roundTrip(source)).toContain(IMAGE);
  });

  it("reloads an image uploaded onto an empty line", () => {
    const image = schema.nodes.image!.create({ src: "/api/images/d/x.png", alt: "Chart" });
    const empty = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create());
    const uploaded = EditorState.create({ schema, doc: empty }).tr.insert(1, image).doc;
    const saved = markdown.serialize(uploaded.toJSON());

    expect(saved).toBe(IMAGE);
    expect(() => schema.nodeFromJSON(markdown.parse(saved)).check()).not.toThrow();
  });
});
