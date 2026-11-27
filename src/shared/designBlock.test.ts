import { describe, expect, it } from "vitest";

import {
  checkDesignsIn,
  designBlock,
  designBlockBody,
  designCaption,
  designIdsIn,
  designsToMarkdown,
  isDesignLanguage,
  MAX_DESIGN_CAPTION_LENGTH,
  parseDesignBlock,
  type ExportDesigns,
} from "./designBlock.ts";

describe("t3-design blocks", () => {
  it("reads an id, an optional frame line and an optional caption", () => {
    expect(parseDesignBlock("abc123")).toEqual({ designId: "abc123", frame: null, caption: null });
    expect(parseDesignBlock("abc123\nThe home screen")).toEqual({
      designId: "abc123",
      frame: null,
      caption: "The home screen",
    });
    expect(parseDesignBlock("abc123\nframe:  Mobile   home \nThe home screen\n")).toEqual({
      designId: "abc123",
      frame: "Mobile home",
      caption: "The home screen",
    });
    // An empty frame line is the whole picture; it lets a caption start with "frame:".
    expect(parseDesignBlock("abc123\nframe:\nframe: a caption")).toEqual({
      designId: "abc123",
      frame: null,
      caption: "frame: a caption",
    });
  });

  it("refuses anything else", () => {
    for (const body of [
      "",
      "not an id!",
      "abc123\nCaption\nmore",
      `abc123\n${"x".repeat(MAX_DESIGN_CAPTION_LENGTH + 1)}`,
      `abc123\nframe: ${"y".repeat(201)}`,
    ]) {
      expect(parseDesignBlock(body)).toBeNull();
    }
  });

  it("writes blocks that read back the same", () => {
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      ["A caption", null],
      [null, "Frame 1"],
      ["frame: tricky", null],
      ["Both  kinds\nof\twhitespace", "  Hero "],
    ];
    for (const [caption, frame] of cases) {
      const parsed = parseDesignBlock(designBlockBody("d1", caption, frame));
      expect(parsed).toEqual({
        designId: "d1",
        frame: frame?.trim() ?? null,
        caption: caption?.replace(/\s+/g, " ").trim() ?? null,
      });
    }
    expect(designBlock("d1", "Cap")).toBe("```t3-design\nd1\nCap\n```");
    expect(isDesignLanguage("t3-design extra")).toBe(true);
    expect(isDesignLanguage("t3-drawio")).toBe(false);
  });

  it("finds each design once, skipping blocks that do not parse", () => {
    const markdown = [designBlock("a"), designBlock("b", "x"), designBlock("a"), "```t3-design\n!\n```"].join(
      "\n\n",
    );
    expect(designIdsIn(markdown)).toEqual(["a", "b"]);
  });

  it("refuses a changed malformed block with a reason, and lets an untouched one stay", () => {
    const bad = "```t3-design\nabc\none\ntwo\n```";
    expect(checkDesignsIn(`Intro\n\n${designBlock("abc")}`)).toBeNull();
    expect(checkDesignsIn(bad)).toMatch(/^The t3-design block: the first line must be the id/);
    expect(checkDesignsIn(`${designBlock("a")}\n\n${bad}`)).toMatch(/^t3-design block 2:/);
    expect(checkDesignsIn(`${bad}\n\nnew text`, bad)).toBeNull();
  });

  it("captions with the caption or title, then the frame", () => {
    expect(designCaption({ designId: "a", frame: null, caption: null }, "Title")).toBe("Title");
    expect(designCaption({ designId: "a", frame: "Hero", caption: "Cap" }, "Title")).toBe(
      "Cap · Frame: Hero",
    );
    expect(designCaption({ designId: "a", frame: null, caption: null }, null)).toBeNull();
  });
});

describe("designs in a markdown export", () => {
  const designs: ExportDesigns = new Map([
    ["pic", { id: "pic", title: "Home [v2]", pictureVersion: 3 }],
    ["blank", { id: "blank", title: "Blank", pictureVersion: null }],
  ]);

  it("turns each block into its picture, linked to the design", () => {
    const markdown = `Before\n\n${designBlock("pic", "Cap", "Hero")}\n\nAfter`;
    expect(designsToMarkdown(markdown, "https://x.test", designs)).toBe(
      "Before\n\n[![Home \\[v2\\]](https://x.test/api/designs/pic/picture/3)](https://x.test/designs/pic)" +
        "\n\nCap · Frame: Hero\n\nAfter",
    );
  });

  it("says so for a design with no picture, and for one that is gone or hidden", () => {
    expect(designsToMarkdown(designBlock("blank"), "https://x.test", designs)).toBe(
      "[Blank](https://x.test/designs/blank) (Design: nothing has been saved in it yet.)",
    );
    expect(designsToMarkdown(designBlock("gone", "Cap"), "https://x.test", designs)).toBe(
      "*Design not found.*\n\nCap",
    );
  });
});
