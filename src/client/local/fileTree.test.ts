import { describe, expect, it } from "vitest";

import { buildFileTree, matchesFileQuery, visibleFileRows, type FileTreeRow } from "./fileTree.ts";

const file = (path: string) => ({
  path,
  title: path.slice(path.lastIndexOf("/") + 1, -3),
  cloudDocId: null,
});

const files = [
  file("README.md"),
  file("docs/plan.md"),
  file("apps/web/README.md"),
  file("docs/specs/api.md"),
  file("AGENTS.md"),
];

const describeRow = (row: FileTreeRow) =>
  `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.folder.name}/ (${row.folder.fileCount})` : row.file.path}`;

describe("file tree", () => {
  it("shows only top-level folders, then root files, until a folder opens", () => {
    const tree = buildFileTree(files);
    expect(visibleFileRows(tree, new Set(), false).map(describeRow)).toEqual([
      "apps/ (1)",
      "docs/ (2)",
      "AGENTS.md",
      "README.md",
    ]);
    expect(visibleFileRows(tree, new Set(["docs", "apps/web"]), false).map(describeRow)).toEqual([
      "apps/ (1)",
      "docs/ (2)",
      "  specs/ (1)",
      "  docs/plan.md",
      "AGENTS.md",
      "README.md",
    ]);
  });

  it("opens every folder holding a match while searching", () => {
    const matches = files.filter((entry) => matchesFileQuery(entry, "api"));
    expect(visibleFileRows(buildFileTree(matches), new Set(), true).map(describeRow)).toEqual([
      "docs/ (1)",
      "  specs/ (1)",
      "    docs/specs/api.md",
    ]);
  });
});
