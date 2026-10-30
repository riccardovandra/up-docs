import { describe, expect, it } from "vitest";

import { COMMENT_CARD_GAP, layoutCommentCards } from "./layout.ts";

describe("layoutCommentCards", () => {
  it("keeps the active card at its passage and pushes neighbours apart", () => {
    const tops = layoutCommentCards(
      [
        { id: "a", anchorTop: 100, height: 80 },
        { id: "b", anchorTop: 120, height: 80 },
        { id: "c", anchorTop: 400, height: 80 },
      ],
      "b",
    );
    expect(tops.get("b")).toBe(120);
    expect(tops.get("a")).toBe(120 - 80 - COMMENT_CARD_GAP);
    expect(tops.get("c")).toBe(400);
  });

  it("shifts everything down when cards would run past the top", () => {
    const tops = layoutCommentCards(
      [
        { id: "a", anchorTop: 0, height: 50 },
        { id: "b", anchorTop: 10, height: 50 },
      ],
      "b",
    );
    expect(tops.get("a")).toBe(0);
    expect(tops.get("b")).toBe(50 + COMMENT_CARD_GAP);
  });
});
