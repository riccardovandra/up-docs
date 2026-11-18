import { describe, expect, it } from "vitest";

import type { DiagramUse } from "../../shared/drawio.ts";
import { groupUses } from "./usedInLogic.ts";

const use = (docId: string, docTitle: string, tabTitle: string): DiagramUse => ({
  docId,
  docTitle,
  tabId: `${docId}-${tabTitle}`,
  tabTitle,
});

const USES = [
  use("a", "Spec", "Overview"),
  use("b", "Plan", "Plan"),
  use("a", "Spec", "Data model"),
  use("c", "Onboarding", "Discovery"),
];

describe("groupUses", () => {
  it("groups tabs by doc in first-seen order", () => {
    const groups = groupUses(USES, "");
    expect(groups.map((group) => [group.docTitle, group.uses.map((u) => u.tabTitle)])).toEqual([
      ["Spec", ["Overview", "Data model"]],
      ["Plan", ["Plan"]],
      ["Onboarding", ["Discovery"]],
    ]);
  });

  it("keeps a whole doc whose title matches the filter", () => {
    expect(groupUses(USES, "spec")[0]?.uses).toHaveLength(2);
  });

  it("keeps only matching tabs when the doc title does not match", () => {
    const groups = groupUses(USES, " data ");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.uses.map((u) => u.tabTitle)).toEqual(["Data model"]);
  });

  it("drops docs with nothing matching", () => {
    expect(groupUses(USES, "zzz")).toEqual([]);
  });
});
