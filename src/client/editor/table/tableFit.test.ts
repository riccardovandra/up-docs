import { describe, expect, it } from "vitest";

import { breakoutFor, overlaps } from "./tableFit.ts";

const column = { left: 300, right: 1004 };
const page = { left: 32, right: 1248 };

describe("breakoutFor", () => {
  it("leaves a table that fits in the column", () => {
    expect(breakoutFor({ required: 704, column, page, commentBeside: false })).toBeNull();
  });

  it("gives a wide table the page width", () => {
    expect(breakoutFor({ required: 900, column, page, commentBeside: false })).toEqual({
      offset: -268,
      width: 1216,
    });
  });

  it("stays clear of the comment margin when a comment sits beside the table", () => {
    expect(breakoutFor({ required: 900, column, page, commentBeside: true })).toEqual({
      offset: -268,
      width: 972,
    });
  });

  it("does nothing when the page has no room beyond the column", () => {
    expect(
      breakoutFor({
        required: 900,
        column,
        page: column,
        commentBeside: false,
      }),
    ).toBeNull();
  });
});

describe("overlaps", () => {
  it("treats touching bands as clear", () => {
    expect(overlaps({ top: 0, bottom: 10 }, { top: 10, bottom: 20 })).toBe(false);
    expect(overlaps({ top: 0, bottom: 11 }, { top: 10, bottom: 20 })).toBe(true);
  });
});
