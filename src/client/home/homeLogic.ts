// The home page's pure rules: which docs a tab, filter and search show, in
// what order, and the labels and badges they carry.

import type { HomeDoc, HomeLibrary, SearchHit } from "../../shared/home.ts";
import type { DocStatus, Project } from "../../shared/protocol.ts";

export type HomeTab = "all" | "yours" | "shared";
export type HomeSort = "opened" | "edited" | "created" | "title";
export type HomeView = "grid" | "list";

export const HOME_TABS: ReadonlyArray<{ readonly id: HomeTab; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "yours", label: "Yours" },
  { id: "shared", label: "Shared with you" },
];

export const HOME_SORTS: ReadonlyArray<{ readonly id: HomeSort; readonly label: string }> = [
  { id: "opened", label: "Last opened" },
  { id: "edited", label: "Last edited" },
  { id: "created", label: "Created" },
  { id: "title", label: "Title" },
];

/** Every project, docs in no project, or one project by key. */
export type ProjectScope =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "project"; readonly key: string };

export const ALL_PROJECTS: ProjectScope = { kind: "all" };
export const NO_PROJECT: ProjectScope = { kind: "none" };

export const sameScope = (a: ProjectScope, b: ProjectScope) =>
  a.kind === b.kind && (a.kind !== "project" || (b.kind === "project" && a.key === b.key));

/** A doc with the project it is filed in. */
export interface HomeEntry extends HomeDoc {
  readonly project: Project | null;
}

export function homeEntries(library: HomeLibrary): ReadonlyArray<HomeEntry> {
  return [
    ...library.projects.flatMap(({ docs, ...project }) => docs.map((doc) => ({ ...doc, project }))),
    ...library.noProjectDocs.map((doc) => ({ ...doc, project: null })),
  ];
}

export interface HomeFilter {
  readonly tab: HomeTab;
  readonly userId: string;
  readonly scope: ProjectScope;
  /** Empty shows every status. */
  readonly statuses: ReadonlySet<DocStatus>;
}

/** Yours are docs whose owner is you; Shared with you is everything else you are on. */
export const isYours = (doc: HomeDoc, userId: string) => doc.owner?.id === userId;

export function inScope(entry: HomeEntry, scope: ProjectScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return entry.project === null;
  return entry.project?.key === scope.key;
}

export function filterEntries(
  entries: ReadonlyArray<HomeEntry>,
  filter: HomeFilter,
): ReadonlyArray<HomeEntry> {
  return entries.filter(
    (entry) =>
      (filter.tab === "all" || isYours(entry, filter.userId) === (filter.tab === "yours")) &&
      inScope(entry, filter.scope) &&
      (filter.statuses.size === 0 || filter.statuses.has(entry.status)),
  );
}

/** The date a card shows and "Last opened" sorts by: your last open, else the last edit. */
export const activityAt = (doc: HomeDoc) => doc.openedAt ?? doc.updatedAt;

export function activityLabel(doc: HomeDoc, now: Date = new Date()): string {
  return `${doc.openedAt === null ? "Edited" : "Opened"} ${formatDay(activityAt(doc), now)}`;
}

const titleCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortEntries<A extends HomeDoc>(
  entries: ReadonlyArray<A>,
  sort: HomeSort,
): Array<A> {
  const key: Record<Exclude<HomeSort, "title">, (doc: HomeDoc) => number> = {
    opened: activityAt,
    edited: (doc) => doc.updatedAt,
    created: (doc) => doc.createdAt,
  };
  if (sort === "title") {
    return entries.toSorted((a, b) => titleCollator.compare(a.title, b.title) || cmp(a.id, b.id));
  }
  const of = key[sort];
  return entries.toSorted((a, b) => of(b) - of(a) || cmp(a.id, b.id));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A search result: the doc, and the snippet of its first tab match when the server found one. */
export interface SearchResult<A extends HomeDoc = HomeEntry> {
  readonly entry: A;
  readonly snippet: string | null;
}

/**
 * Title matches show at once; server hits on tab Markdown join them as they
 * arrive. Order follows `entries`, which the caller has already filtered and sorted.
 */
export function searchEntries<A extends HomeDoc>(
  entries: ReadonlyArray<A>,
  query: string,
  hits: ReadonlyArray<SearchHit>,
): ReadonlyArray<SearchResult<A>> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries.map((entry) => ({ entry, snippet: null }));
  const snippets = new Map<string, string>();
  for (const hit of hits) if (!snippets.has(hit.docId)) snippets.set(hit.docId, hit.snippet);
  return entries.flatMap((entry) => {
    const snippet = snippets.get(entry.id) ?? null;
    return entry.title.toLowerCase().includes(needle) || snippet !== null
      ? [{ entry, snippet }]
      : [];
  });
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Oct 21", with the year when it is not this year. */
export function formatDay(at: number, now: Date = new Date()): string {
  const date = new Date(at);
  return (date.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(date);
}

/** T3 Code's project icon colours, in its order, as Tailwind's 600 (light) and 400 (dark) shades. */
const MONOGRAM_COLORS: ReadonlyArray<readonly [light: string, dark: string]> = [
  ["#4b5563", "#9ca3af"], // gray
  ["#dc2626", "#f87171"], // red
  ["#ea580c", "#fb923c"], // orange
  ["#d97706", "#fbbf24"], // amber
  ["#ca8a04", "#facc15"], // yellow
  ["#65a30d", "#a3e635"], // lime
  ["#16a34a", "#4ade80"], // green
  ["#059669", "#34d399"], // emerald
  ["#0d9488", "#2dd4bf"], // teal
  ["#0891b2", "#22d3ee"], // cyan
  ["#0284c7", "#38bdf8"], // sky
  ["#2563eb", "#60a5fa"], // blue
  ["#4f46e5", "#818cf8"], // indigo
  ["#7c3aed", "#a78bfa"], // violet
  ["#9333ea", "#c084fc"], // purple
  ["#c026d3", "#e879f9"], // fuchsia
  ["#db2777", "#f472b6"], // pink
  ["#e11d48", "#fb7185"], // rose
];

export interface ProjectMonogram {
  readonly text: string;
  readonly light: string;
  readonly dark: string;
}

/**
 * The initials badge T3 Code shows for a project without an icon, derived the
 * same way (apps/web/src/projectIdentity.ts) so a project looks alike in both.
 */
export function projectMonogram(name: string): ProjectMonogram {
  const normalized = name.normalize("NFKC").trim();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  let text = "PR";
  if (firstWord) {
    const glyphs = Array.from(firstWord);
    const first = glyphs[0] ?? "P";
    const second =
      glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
      (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
      first;
    text = Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
  }
  const seed = normalized.toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % MONOGRAM_COLORS.length;
  }
  const [light, dark] = MONOGRAM_COLORS[index] ?? MONOGRAM_COLORS[11]!;
  return { text, light, dark };
}

/** One block of a card preview (see `HomeDoc.preview`). */
export interface PreviewBlock {
  readonly heading: boolean;
  readonly text: string;
}

export const previewBlocks = (preview: string): ReadonlyArray<PreviewBlock> =>
  preview
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      line.startsWith("# ")
        ? { heading: true, text: line.slice(2) }
        : { heading: false, text: line },
    );

/** The project choice saved per surface: standalone, or inside T3 Code with the panel's project key. */
export interface StoredScope {
  readonly embedKey: string | null;
  readonly scope: ProjectScope;
}

export function parseStoredScope(raw: string | null): StoredScope | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredScope> | null;
    const scope = value?.scope;
    const embedKey = value?.embedKey ?? null;
    if (typeof embedKey !== "string" && embedKey !== null) return null;
    if (scope?.kind === "all" || scope?.kind === "none") return { embedKey, scope };
    if (scope?.kind === "project" && typeof scope.key === "string") {
      return { embedKey, scope: { kind: "project", key: scope.key } };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The project the home page opens on. Inside T3 Code it is the panel's
 * project, even before it has any docs, unless the person picked something
 * else while in that project; standalone it is the last pick. A picked project
 * not in `projectKeys` (gone, or not visible to this person) is dropped.
 */
export function restoreScope(input: {
  readonly stored: StoredScope | null;
  readonly embedKey: string | null;
  readonly projectKeys: ReadonlySet<string>;
}): ProjectScope {
  const { stored, embedKey, projectKeys } = input;
  const usable = (scope: ProjectScope): boolean =>
    scope.kind !== "project" || projectKeys.has(scope.key);
  if (stored && stored.embedKey === embedKey && usable(stored.scope)) return stored.scope;
  return embedKey === null ? ALL_PROJECTS : { kind: "project", key: embedKey };
}

/** Pinned doc ids, kept on this device only. Anything malformed reads as no pins. */
export function parsePins(raw: string | null): ReadonlyArray<string> {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export const togglePin = (pins: ReadonlyArray<string>, docId: string): ReadonlyArray<string> =>
  pins.includes(docId) ? pins.filter((id) => id !== docId) : [...pins, docId];

/** Pinned docs first, each group keeping the order `entries` came in. */
export function pinnedFirst<A extends HomeDoc>(
  entries: ReadonlyArray<A>,
  pins: ReadonlySet<string>,
): ReadonlyArray<A> {
  if (pins.size === 0) return entries;
  return [
    ...entries.filter((entry) => pins.has(entry.id)),
    ...entries.filter((entry) => !pins.has(entry.id)),
  ];
}
