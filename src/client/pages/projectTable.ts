// Sorting, filtering and labels for the Settings projects table.

import type { HomeProject } from "../../shared/home.ts";

export type ProjectSortKey = "name" | "docs" | "updated";
export type SortDirection = "asc" | "desc";

export interface ProjectSort {
  readonly key: ProjectSortKey;
  readonly direction: SortDirection;
}

export interface ProjectRow {
  readonly project: HomeProject;
  readonly docCount: number;
  /** The newest `updatedAt` among the project's docs; null when it has none. */
  readonly updatedAt: number | null;
  readonly source: ProjectSource;
}

export interface ProjectSource {
  readonly kind: "github" | "local" | "other";
  /** `owner/repo` for a repository, the T3 Code title otherwise. */
  readonly label: string;
}

/** Where a project's key comes from: a git repository, or a T3 Code title. */
export function projectSource(key: string): ProjectSource {
  if (key.startsWith("title:")) return { kind: "local", label: "Local" };
  const github = /^github\.com\/(.+)$/.exec(key);
  if (github) return { kind: "github", label: github[1]! };
  return { kind: "other", label: key };
}

export function projectRows(projects: ReadonlyArray<HomeProject>): ReadonlyArray<ProjectRow> {
  return projects.map((project) => ({
    project,
    docCount: project.docs.length,
    updatedAt: project.docs.reduce<number | null>(
      (latest, doc) => (latest === null || doc.updatedAt > latest ? doc.updatedAt : latest),
      null,
    ),
    source: projectSource(project.key),
  }));
}

const byName = (a: ProjectRow, b: ProjectRow) =>
  a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "base" });

/** Rows in `sort` order; ties, and projects with no docs when sorting by date, fall back to name. */
export function sortProjectRows(
  rows: ReadonlyArray<ProjectRow>,
  sort: ProjectSort,
): ReadonlyArray<ProjectRow> {
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows.toSorted((a, b) => {
    if (sort.key === "name") return sign * byName(a, b);
    if (sort.key === "docs") return sign * (a.docCount - b.docCount) || byName(a, b);
    // Projects that were never updated sit last in either direction.
    if (a.updatedAt === null || b.updatedAt === null) {
      return (a.updatedAt === null ? 1 : 0) - (b.updatedAt === null ? 1 : 0) || byName(a, b);
    }
    return sign * (a.updatedAt - b.updatedAt) || byName(a, b);
  });
}

/** Rows whose name or key contains `query` (case-insensitive), minus empty ones when `hideEmpty`. */
export function filterProjectRows(
  rows: ReadonlyArray<ProjectRow>,
  input: { readonly query: string; readonly hideEmpty: boolean },
): ReadonlyArray<ProjectRow> {
  const query = input.query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      !(input.hideEmpty && row.docCount === 0) &&
      (query === "" ||
        row.project.name.toLocaleLowerCase().includes(query) ||
        row.project.key.toLocaleLowerCase().includes(query)),
  );
}

/** Clicking a header: the same column flips direction; a new one starts in its natural order. */
export function nextSort(current: ProjectSort, key: ProjectSortKey): ProjectSort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "name" ? "asc" : "desc" };
}
