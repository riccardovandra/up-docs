import { describe, expect, it } from "vitest";

import { closeTab, parseTabSets, retitleTab, visitTab, type OpenTab } from "./openTabs.ts";

const spec: OpenTab = { key: "doc:spec", path: "/d/spec", title: "Spec" };
const plan: OpenTab = { key: "doc:plan", path: "/d/plan/t2", title: "Build plan" };
const run: OpenTab = { key: "doc:run", path: "/d/run", title: "First run" };

describe("visitTab", () => {
  it("opens a new doc as the last tab", () => {
    expect(visitTab([spec], "/d/plan")).toEqual([
      spec,
      { key: "doc:plan", path: "/d/plan", title: "Untitled" },
    ]);
  });

  it("keeps one tab per doc and remembers its in-doc tab", () => {
    const tabs = visitTab([spec, plan], "/d/spec/t9");
    expect(tabs).toEqual([{ ...spec, path: "/d/spec/t9" }, plan]);
  });

  it("titles a project file from its path", () => {
    expect(visitTab([], "/local/docs/build-plan.md")).toEqual([
      { key: "local:docs/build-plan.md", path: "/local/docs/build-plan.md", title: "build plan" },
    ]);
  });

  it("ignores home and settings", () => {
    const tabs = [spec];
    expect(visitTab(tabs, "/")).toBe(tabs);
    expect(visitTab(tabs, "/settings")).toBe(tabs);
  });
});

describe("closeTab", () => {
  it("moves to the right-hand neighbour when the active tab closes", () => {
    expect(closeTab([spec, plan, run], "doc:plan", "doc:plan")).toEqual({
      tabs: [spec, run],
      next: run.path,
    });
  });

  it("falls back to the left neighbour, then home", () => {
    expect(closeTab([spec, plan], "doc:plan", "doc:plan").next).toBe(spec.path);
    expect(closeTab([spec], "doc:spec", "doc:spec").next).toBe("/");
  });

  it("stays put when a background tab closes", () => {
    expect(closeTab([spec, plan], "doc:spec", "doc:plan")).toEqual({ tabs: [plan], next: null });
  });
});

it("retitles a tab once its doc loads", () => {
  const tabs = retitleTab([spec, plan], "doc:plan", "Build plan v2");
  expect(tabs[1]?.title).toBe("Build plan v2");
  expect(retitleTab(tabs, "doc:plan", "Build plan v2")).toBe(tabs);
});

describe("parseTabSets", () => {
  it("keeps each project's tabs apart", () => {
    const stored = JSON.stringify({ "github.com/a/app": [spec], "": [plan] });
    expect(parseTabSets(stored)).toEqual({ "github.com/a/app": [spec], "": [plan] });
  });

  it("drops stored tabs that are malformed or point elsewhere", () => {
    const stored = JSON.stringify({
      "github.com/a/app": [spec, { key: "doc:x", path: "/d/y", title: "x" }, { key: 1 }],
      broken: "nope",
    });
    expect(parseTabSets(stored)).toEqual({ "github.com/a/app": [spec], broken: [] });
    expect(parseTabSets("not json")).toEqual({});
    expect(parseTabSets(null)).toEqual({});
  });

  it("files tabs saved before projects under no project", () => {
    expect(parseTabSets(JSON.stringify([spec, run]))).toEqual({ "": [spec, run] });
  });
});
