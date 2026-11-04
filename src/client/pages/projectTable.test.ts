import { describe, expect, it } from "vitest";

import type { HomeDoc, HomeProject } from "../../shared/home.ts";
import {
  filterProjectRows,
  nextSort,
  projectRows,
  projectSource,
  sortProjectRows,
} from "./projectTable.ts";

function doc(id: string, updatedAt: number): HomeDoc {
  return {
    id,
    projectId: "p",
    title: id,
    status: "thinking",
    group: null,
    createdAt: 0,
    updatedAt,
    role: "owner",
    owner: null,
    preview: "",
    memberCount: 1,
    openedAt: null,
  };
}

const project = (name: string, key: string, docs: ReadonlyArray<HomeDoc> = []): HomeProject => ({
  id: name,
  key,
  name,
  createdAt: 0,
  docs,
});

const rows = projectRows([
  project("beta", "github.com/me/beta", [doc("b1", 5), doc("b2", 9)]),
  project("Alpha", "title:alpha", [doc("a1", 3)]),
  project("gamma", "title:gamma"),
  project("delta", "github.com/me/delta", [doc("d1", 1), doc("d2", 2), doc("d3", 3)]),
]);
const names = (list: typeof rows) => list.map((row) => row.project.name);

describe("projectSource", () => {
  it("names a GitHub repository by owner/repo and a title key as local", () => {
    expect(projectSource("github.com/owner/repo")).toEqual({ kind: "github", label: "owner/repo" });
    expect(projectSource("title:bark")).toEqual({ kind: "local", label: "Local" });
    expect(projectSource("gitlab.com/a/b")).toEqual({ kind: "other", label: "gitlab.com/a/b" });
  });
});

describe("projectRows", () => {
  it("counts docs and takes the newest update", () => {
    expect(rows.map((row) => [row.docCount, row.updatedAt])).toEqual([
      [2, 9],
      [1, 3],
      [0, null],
      [3, 3],
    ]);
  });
});

describe("sortProjectRows", () => {
  it("sorts by name ignoring case", () => {
    expect(names(sortProjectRows(rows, { key: "name", direction: "asc" }))).toEqual([
      "Alpha",
      "beta",
      "delta",
      "gamma",
    ]);
  });

  it("sorts by doc count", () => {
    expect(names(sortProjectRows(rows, { key: "docs", direction: "desc" }))).toEqual([
      "delta",
      "beta",
      "Alpha",
      "gamma",
    ]);
  });

  it("sorts by update, ties by name, never-updated last both ways", () => {
    expect(names(sortProjectRows(rows, { key: "updated", direction: "desc" }))).toEqual([
      "beta",
      "Alpha",
      "delta",
      "gamma",
    ]);
    expect(names(sortProjectRows(rows, { key: "updated", direction: "asc" }))).toEqual([
      "Alpha",
      "delta",
      "beta",
      "gamma",
    ]);
  });
});

describe("filterProjectRows", () => {
  it("matches name or key and can hide empty projects", () => {
    expect(names(filterProjectRows(rows, { query: "ALP", hideEmpty: false }))).toEqual(["Alpha"]);
    expect(names(filterProjectRows(rows, { query: "me/", hideEmpty: false }))).toEqual([
      "beta",
      "delta",
    ]);
    expect(names(filterProjectRows(rows, { query: " ", hideEmpty: true }))).toEqual([
      "beta",
      "Alpha",
      "delta",
    ]);
  });
});

describe("nextSort", () => {
  it("flips the same column and starts a new one in its natural order", () => {
    expect(nextSort({ key: "name", direction: "asc" }, "name")).toEqual({
      key: "name",
      direction: "desc",
    });
    expect(nextSort({ key: "name", direction: "asc" }, "docs")).toEqual({
      key: "docs",
      direction: "desc",
    });
    expect(nextSort({ key: "docs", direction: "desc" }, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });
});
