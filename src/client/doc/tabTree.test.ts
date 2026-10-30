import { describe, expect, it } from "vitest";

import type { Tab } from "../../shared/protocol.ts";
import { moveTarget, orderTabs } from "./tabTree.ts";

const tab = (id: string, parentTabId: string | null, position: number): Tab => ({
  id,
  docId: "doc",
  parentTabId,
  position,
  title: id,
  markdown: "",
  version: 1,
  updatedAt: 0,
});

// a
//   a1
//   a2
// b
const tabs = [tab("b", null, 1), tab("a2", "a", 1), tab("a", null, 0), tab("a1", "a", 0)];

describe("tab tree", () => {
  it("orders depth-first with siblings by position", () => {
    expect(orderTabs(tabs).map(({ tab, depth }) => `${depth}:${tab.id}`)).toEqual([
      "0:a",
      "1:a1",
      "1:a2",
      "0:b",
    ]);
  });

  it("moves within siblings and stops at the ends", () => {
    expect(moveTarget(tabs, "a2", "up")).toEqual({ parentTabId: "a", position: 0 });
    expect(moveTarget(tabs, "a1", "down")).toEqual({ parentTabId: "a", position: 1 });
    expect(moveTarget(tabs, "a1", "up")).toBeNull();
    expect(moveTarget(tabs, "b", "down")).toBeNull();
  });

  it("indents under the previous sibling and outdents after the parent", () => {
    expect(moveTarget(tabs, "b", "indent")).toEqual({ parentTabId: "a", position: 2 });
    expect(moveTarget(tabs, "a", "indent")).toBeNull();
    expect(moveTarget(tabs, "a1", "outdent")).toEqual({ parentTabId: null, position: 1 });
    expect(moveTarget(tabs, "a", "outdent")).toBeNull();
  });
});
