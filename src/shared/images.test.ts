import { describe, expect, it } from "vitest";

import { joinImageAlt, splitImageAlt } from "./images.ts";

describe("image alt widths", () => {
  it.each([
    ["Chart|480", { alt: "Chart", width: 480 }],
    ["|320", { alt: "", width: 320 }],
    ["a|b|640", { alt: "a|b", width: 640 }],
    ["Chart", { alt: "Chart", width: null }],
    ["a|b", { alt: "a|b", width: null }],
    ["tiny|5", { alt: "tiny|5", width: null }],
    ["huge|9999", { alt: "huge|9999", width: null }],
    ["", { alt: "", width: null }],
  ])("splits %j", (text, expected) => {
    expect(splitImageAlt(text)).toEqual(expected);
  });

  it("joins back to the stored text", () => {
    expect(joinImageAlt("Chart", 480)).toBe("Chart|480");
    expect(joinImageAlt("Chart", null)).toBe("Chart");
  });
});
