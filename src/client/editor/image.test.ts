import { flattenExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { describe, expect, it } from "vitest";

import { createEditorExtensions } from "./extensions.ts";

const markdown = new MarkdownManager({ extensions: flattenExtensions(createEditorExtensions()) });
const roundTrip = (source: string) => markdown.serialize(markdown.parse(source));

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
});
