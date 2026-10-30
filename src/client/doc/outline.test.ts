import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { activeAfter, extractHeadings, newHeadingKeys, sameOutline } from "./outline.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    heading: { group: "block", content: "text*", attrs: { level: { default: 1 } } },
    blockquote: { group: "block", content: "block+" },
    text: {},
  },
});

type Block = readonly [level: number, text: string] | string | { readonly quote: Array<Block> };

const node = (block: Block): ReturnType<typeof schema.node> => {
  if (typeof block === "string") {
    return schema.node("paragraph", null, block ? [schema.text(block)] : []);
  }
  if ("quote" in block) return schema.node("blockquote", null, block.quote.map(node));
  const [level, text] = block as readonly [number, string];
  return schema.node("heading", { level }, text ? [schema.text(text)] : []);
};

const doc = (...blocks: Array<Block>) => schema.node("doc", null, blocks.map(node));

describe("extractHeadings", () => {
  it("lists H1–H3 in reading order with positions, skipping deeper and empty headings", () => {
    const tree = doc([1, "Plan"], "intro", [2, "Goals"], [4, "Too deep"], [3, "Detail"], [2, ""]);
    const headings = extractHeadings(tree);
    expect(headings.map(({ level, text }) => [level, text])).toEqual([
      [1, "Plan"],
      [2, "Goals"],
      [3, "Detail"],
    ]);
    for (const heading of headings) {
      expect(tree.nodeAt(heading.pos)?.textContent).toBe(heading.text);
    }
  });

  it("finds headings nested in containers", () => {
    expect(extractHeadings(doc({ quote: [[2, "Quoted"]] })).map((h) => h.text)).toEqual(["Quoted"]);
  });

  it("normalizes whitespace in heading text", () => {
    expect(extractHeadings(doc([2, "  Open   questions "]))[0]?.text).toBe("Open questions");
  });

  it("keeps keys stable when content elsewhere changes", () => {
    const before = extractHeadings(doc([2, "Goals"], "one", [2, "Risks"]));
    const after = extractHeadings(doc("new intro", [2, "Goals"], "one two three", [2, "Risks"]));
    expect(after.map((h) => h.key)).toEqual(before.map((h) => h.key));
    expect(sameOutline(before, after)).toBe(true);
  });

  it("gives repeated headings distinct keys", () => {
    const keys = extractHeadings(doc([2, "Notes"], [2, "Notes"], [3, "Notes"])).map((h) => h.key);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("sameOutline", () => {
  it("detects renamed, re-levelled, added and removed headings", () => {
    const base = extractHeadings(doc([2, "Goals"], [2, "Risks"]));
    expect(sameOutline(base, extractHeadings(doc([2, "Goals"], [2, "Risk"])))).toBe(false);
    expect(sameOutline(base, extractHeadings(doc([2, "Goals"], [3, "Risks"])))).toBe(false);
    expect(sameOutline(base, extractHeadings(doc([2, "Goals"])))).toBe(false);
    expect(sameOutline(base, extractHeadings(doc([2, "Goals"], [2, "Risks"], [2, "Next"])))).toBe(
      false,
    );
  });
});

describe("newHeadingKeys", () => {
  it("returns only sections that were not there before, as an agent appends them", () => {
    const first = extractHeadings(doc([1, "Plan"], [2, "Goals"]));
    const second = extractHeadings(doc([1, "Plan"], [2, "Goals"], "text", [2, "Risks"]));
    const third = extractHeadings(
      doc([1, "Plan"], [2, "Goals"], [2, "Risks"], [3, "Vendor"], [2, "Next steps"]),
    );
    expect(newHeadingKeys(first, second)).toEqual(["2:Risks"]);
    expect(newHeadingKeys(second, third)).toEqual(["3:Vendor", "2:Next steps"]);
    expect(newHeadingKeys(third, third)).toEqual([]);
  });

  it("treats a renamed heading as new and ignores removals", () => {
    const before = extractHeadings(doc([2, "Goals"], [2, "Risks"]));
    const after = extractHeadings(doc([2, "Outcomes"]));
    expect(newHeadingKeys(before, after)).toEqual(["2:Outcomes"]);
  });
});

describe("activeAfter", () => {
  const order = ["a", "b", "c"];
  const none = new Set<string>();

  it("prefers the topmost heading in the reading band", () => {
    expect(activeAfter(order, "a", new Set(["c", "b"]), none)).toBe("b");
  });

  it("keeps the last passed heading active between headings", () => {
    expect(activeAfter(order, "b", none, none)).toBe("b");
  });

  it("steps back a section when scrolling up past the active heading", () => {
    expect(activeAfter(order, "b", none, new Set(["b"]))).toBe("a");
    expect(activeAfter(order, "a", none, new Set(["a"]))).toBe(null);
  });

  it("drops an active heading that no longer exists", () => {
    expect(activeAfter(order, "gone", none, none)).toBe(null);
  });
});
