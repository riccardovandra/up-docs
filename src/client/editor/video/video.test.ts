import { flattenExtensions, getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { buildDocTextIndex } from "../../comments/editorAnchors.ts";
import { createEditorExtensions } from "../extensions.ts";

const extensions = flattenExtensions(createEditorExtensions());
const markdown = new MarkdownManager({ extensions });
const roundTrip = (source: string) => markdown.serialize(markdown.parse(source));

const YOUTUBE = "```t3-video\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\nThe walkthrough\n```";

describe("video markdown", () => {
  it.each([
    ["a link with a title", YOUTUBE],
    ["a link alone", "```t3-video\nhttps://youtu.be/dQw4w9WgXcQ\n```"],
    [
      "an uploaded file",
      "```t3-video\n/api/videos/d/0b6f3a52-6a3e-4b0c-9a55-2b1d1f4f2a10.mp4\n```",
    ],
    ["an unsupported source, kept as written", "```t3-video\nhttps://example.com/a.mp4\n```"],
    ["a tilde fence", "~~~t3-video\nhttps://youtu.be/dQw4w9WgXcQ\n~~~"],
    ["text around it", `Before\n\n${YOUTUBE}\n\nAfter`],
  ])("round-trips %s", (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("leaves a bare link out of any video block", () => {
    const parsed = markdown.parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(JSON.stringify(parsed)).not.toContain("codeBlock");
  });

  it("keeps the source out of the text comments anchor to", () => {
    const parsed = markdown.parse(`Before\n\n${YOUTUBE}\n\nAfter`);
    const doc = Node.fromJSON(getSchema(extensions), parsed);
    expect(buildDocTextIndex(doc).text).toBe("Before\nAfter");
  });
});
