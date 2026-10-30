import { describe, expect, it } from "vitest";

import { analyzeWidget } from "../../../shared/widget/validate.ts";
import {
  getInsertAction,
  menuInsertActions,
  nextDiagramId,
  registerInsertAction,
  STARTER_DIAGRAM,
} from "./insertActions.ts";

const ids = () => menuInsertActions().map((action) => action.id);

describe("insert actions", () => {
  it("lists the built-in inserts in the + menu, in order", () => {
    expect(ids()).toEqual([
      "heading",
      "bullet-list",
      "numbered-list",
      "checklist",
      "quote",
      "code",
      "divider",
      "diagram",
      "table",
      "image",
      "video-link",
      "video-upload",
    ]);
  });

  it("lets a feature replace a toolbar action and puts the default back on unregister", () => {
    const builtIn = getInsertAction("table");
    const before = menuInsertActions();
    const unregister = registerInsertAction({ id: "table", label: "Rich table", run: () => {} });
    expect(getInsertAction("table")?.label).toBe("Rich table");
    // Without an order it leaves the menu but stays reachable from the toolbar button.
    expect(ids()).not.toContain("table");
    expect(menuInsertActions()).not.toBe(before);
    unregister();
    expect(getInsertAction("table")).toBe(builtIn);
    expect(ids()).toContain("table");
  });

  it("adds new actions to the menu by order", () => {
    const unregister = registerInsertAction({
      id: "rich-table",
      label: "Rich table",
      order: 75,
      run: () => {},
    });
    expect(ids().slice(-5)).toEqual(["table", "rich-table", "image", "video-link", "video-upload"]);
    unregister();
    expect(getInsertAction("rich-table")).toBeUndefined();
  });

  it("does not let a stale unregister remove a newer registration", () => {
    const first = registerInsertAction({ id: "x", label: "One", run: () => {} });
    const unregisterSecond = registerInsertAction({ id: "x", label: "Two", run: () => {} });
    first();
    expect(getInsertAction("x")?.label).toBe("Two");
    unregisterSecond();
    expect(getInsertAction("x")?.label).toBe("One");
  });
});

describe("diagram insert", () => {
  it("starts from a diagram that passes the widget validator", () => {
    expect(analyzeWidget(STARTER_DIAGRAM).diagnostics).toEqual([]);
  });

  it("names each new diagram uniquely within the tab", () => {
    expect(nextDiagramId("")).toBe("diagram-1");
    const tab = [
      "```t3-widget id=diagram-1",
      STARTER_DIAGRAM,
      "```",
      "",
      "```t3-widget id=diagram-3",
      STARTER_DIAGRAM,
      "```",
    ].join("\n");
    expect(nextDiagramId(tab)).toBe("diagram-2");
  });
});
