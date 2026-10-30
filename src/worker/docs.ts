// Doc and tab service functions. The REST API, the DocRoom and the future
// `/mcp` endpoint all call these, so every surface shares one behaviour.
// Writes to an existing doc must go through the DocRoom (see `rooms.ts`) so
// open editors hear about them; these functions only touch D1.

import { projectNameFromKey, titleProjectKey } from "../shared/embed.ts";
import type {
  DocStatus,
  DocSummary,
  DocWithTabs,
  Library,
  Project,
  Tab,
  TabPlacement,
} from "../shared/protocol.ts";
import { ownerMembershipStatement } from "./access.ts";
import { randomId } from "./crypto.ts";

interface DocRow {
  id: string;
  project_id: string | null;
  title: string;
  status: DocStatus;
  created_at: number;
  updated_at: number;
}

interface TabRow {
  id: string;
  doc_id: string;
  parent_tab_id: string | null;
  position: number;
  title: string;
  markdown: string;
  version: number;
  updated_at: number;
}

const toDoc = (row: DocRow): DocSummary => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toTab = (row: TabRow): Tab => ({
  id: row.id,
  docId: row.doc_id,
  parentTabId: row.parent_tab_id,
  position: row.position,
  title: row.title,
  markdown: row.markdown,
  version: row.version,
  updatedAt: row.updated_at,
});

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not_found: ${what}`);
  }
}

/** A tab move that would put it under itself or one of its descendants. */
export class InvalidMoveError extends Error {
  constructor() {
    super("invalid_move");
  }
}

/** Deleting the doc's only top-level tab would leave it with nothing to show. */
export class LastTabError extends Error {
  constructor() {
    super("last_tab");
  }
}

/**
 * Durable Object RPC rethrows errors as plain `Error`s with only the message
 * intact, so callers of a DocRoom stub restore the class from it.
 */
export function reviveError(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  if (cause.message.startsWith("not_found: ")) {
    return new NotFoundError(cause.message.slice("not_found: ".length));
  }
  if (cause.message === "invalid_move") return new InvalidMoveError();
  if (cause.message === "last_tab") return new LastTabError();
  return cause;
}

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  created_at: number;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  key: row.key,
  name: row.name,
  createdAt: row.created_at,
});

export async function listLibrary(db: D1Database): Promise<Library> {
  const [projects, docs] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE"),
    db.prepare("SELECT * FROM docs ORDER BY updated_at DESC"),
  ]);
  const docsByProject = new Map<string | null, Array<DocSummary>>();
  for (const row of (docs?.results ?? []) as unknown as Array<DocRow>) {
    const list = docsByProject.get(row.project_id) ?? [];
    list.push(toDoc(row));
    docsByProject.set(row.project_id, list);
  }
  return {
    projects: ((projects?.results ?? []) as unknown as Array<ProjectRow>).map((row) => ({
      ...toProject(row),
      docs: docsByProject.get(row.id) ?? [],
    })),
    noProjectDocs: docsByProject.get(null) ?? [],
  };
}

export async function getProject(db: D1Database, projectId: string): Promise<Project> {
  const row = await db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .bind(projectId)
    .first<ProjectRow>();
  if (!row) throw new NotFoundError("project");
  return toProject(row);
}

export async function findProjectByKey(db: D1Database, key: string): Promise<Project | null> {
  const row = await db
    .prepare("SELECT * FROM projects WHERE key = ?")
    .bind(key)
    .first<ProjectRow>();
  return row ? toProject(row) : null;
}

function upsertProjectStatement(
  db: D1Database,
  input: { readonly key: string; readonly name?: string | undefined; readonly rename: boolean },
  now: number,
) {
  return db
    .prepare(
      `INSERT INTO projects (id, key, name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET name = CASE WHEN ? THEN excluded.name ELSE name END
       RETURNING *`,
    )
    .bind(
      randomId(),
      input.key,
      input.name?.trim() || projectNameFromKey(input.key),
      now,
      input.rename ? 1 : 0,
    );
}

/**
 * The project with this key, created when missing. An existing project keeps
 * its name: T3 Code's sync owns names, and an agent filing a doc must not
 * relabel the project. Keys must already be normalised (`normalizeProjectKey`).
 */
export async function ensureProject(
  db: D1Database,
  input: { readonly key: string; readonly name?: string | undefined; readonly now: number },
): Promise<Project> {
  const row = await upsertProjectStatement(
    db,
    { ...input, rename: false },
    input.now,
  ).first<ProjectRow>();
  return toProject(row!);
}

/**
 * Upserts T3 Code's projects by key, in one transaction, and returns them in
 * input order. Names follow the latest T3 Code title. A repository's first
 * sync takes over the same-titled project made by name before it (in the
 * library or by an agent), so those docs stay with it. Keys must already be
 * normalised.
 */
export async function syncProjects(
  db: D1Database,
  projects: ReadonlyArray<{ readonly key: string; readonly name: string }>,
  now: number,
): Promise<ReadonlyArray<Project>> {
  if (projects.length === 0) return [];
  const results = await db.batch<ProjectRow>(
    projects.flatMap((project) => [
      db
        .prepare(
          `UPDATE projects SET key = ?1
           WHERE key = ?2 AND ?1 NOT LIKE 'title:%'
             AND NOT EXISTS (SELECT 1 FROM projects WHERE key = ?1)`,
        )
        .bind(project.key, titleProjectKey(project.name)),
      upsertProjectStatement(db, { ...project, rename: true }, now),
    ]),
  );
  return projects.map((_, index) => toProject(results[index * 2 + 1]!.results[0]!));
}

/** A project made by name: the one with its title key when that already exists. */
export function createProject(db: D1Database, name: string, now: number): Promise<Project> {
  return ensureProject(db, { key: titleProjectKey(name), name, now });
}

/** Creates a doc with one empty top-level tab, owned by `ownerId`. */
export async function createDoc(
  db: D1Database,
  input: {
    readonly projectId: string | null;
    readonly title: string;
    readonly ownerId: string;
    readonly now: number;
  },
): Promise<DocWithTabs> {
  if (input.projectId !== null) await getProject(db, input.projectId);
  const doc: DocSummary = {
    id: randomId(),
    projectId: input.projectId,
    title: input.title,
    status: "thinking",
    createdAt: input.now,
    updatedAt: input.now,
  };
  const tab: Tab = {
    id: randomId(),
    docId: doc.id,
    parentTabId: null,
    position: 0,
    title: input.title,
    markdown: "",
    version: 1,
    updatedAt: input.now,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO docs (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(doc.id, doc.projectId, doc.title, doc.status, doc.createdAt, doc.updatedAt),
    insertTabStatement(db, tab),
    ownerMembershipStatement(db, { docId: doc.id, userId: input.ownerId, now: input.now }),
  ]);
  return { doc, tabs: [tab] };
}

export async function getDoc(db: D1Database, docId: string): Promise<DocWithTabs> {
  const [docs, tabs] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM docs WHERE id = ?").bind(docId),
    db.prepare("SELECT * FROM tabs WHERE doc_id = ? ORDER BY position, updated_at").bind(docId),
  ]);
  const doc = docs?.results[0] as unknown as DocRow | undefined;
  if (!doc) throw new NotFoundError("doc");
  return { doc: toDoc(doc), tabs: ((tabs?.results ?? []) as unknown as Array<TabRow>).map(toTab) };
}

export async function setDocStatus(
  db: D1Database,
  input: { readonly docId: string; readonly status: DocStatus; readonly now: number },
): Promise<DocSummary> {
  const row = await db
    .prepare("UPDATE docs SET status = ?, updated_at = ? WHERE id = ? RETURNING *")
    .bind(input.status, input.now, input.docId)
    .first<DocRow>();
  if (!row) throw new NotFoundError("doc");
  return toDoc(row);
}

export async function renameDoc(
  db: D1Database,
  input: { readonly docId: string; readonly title: string; readonly now: number },
): Promise<DocSummary> {
  const row = await db
    .prepare("UPDATE docs SET title = ?, updated_at = ? WHERE id = ? RETURNING *")
    .bind(input.title, input.now, input.docId)
    .first<DocRow>();
  if (!row) throw new NotFoundError("doc");
  return toDoc(row);
}

/** Moves a doc to another project, or to none. Call through the DocRoom. */
export async function setDocProject(
  db: D1Database,
  input: { readonly docId: string; readonly projectId: string | null },
): Promise<DocSummary> {
  if (input.projectId !== null) await getProject(db, input.projectId);
  const row = await db
    .prepare("UPDATE docs SET project_id = ? WHERE id = ? RETURNING *")
    .bind(input.projectId, input.docId)
    .first<DocRow>();
  if (!row) throw new NotFoundError("doc");
  return toDoc(row);
}

/** Deletes a doc; foreign keys cascade to its tabs, comments, linked threads and members. */
export async function deleteDoc(db: D1Database, docId: string): Promise<void> {
  const row = await db.prepare("DELETE FROM docs WHERE id = ? RETURNING id").bind(docId).first();
  if (!row) throw new NotFoundError("doc");
}

export async function getTab(db: D1Database, tabId: string): Promise<Tab> {
  const row = await db.prepare("SELECT * FROM tabs WHERE id = ?").bind(tabId).first<TabRow>();
  if (!row) throw new NotFoundError("tab");
  return toTab(row);
}

/** A tab's markdown, the unit agents read and export works from. */
export async function getTabMarkdown(db: D1Database, tabId: string): Promise<string> {
  return (await getTab(db, tabId)).markdown;
}

function insertTabStatement(db: D1Database, tab: Tab) {
  return db
    .prepare(
      `INSERT INTO tabs (id, doc_id, parent_tab_id, position, title, markdown, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tab.id,
      tab.docId,
      tab.parentTabId,
      tab.position,
      tab.title,
      tab.markdown,
      tab.version,
      tab.updatedAt,
    );
}

function touchDocStatement(db: D1Database, docId: string, now: number) {
  return db.prepare("UPDATE docs SET updated_at = ? WHERE id = ?").bind(now, docId);
}

/** Appends a tab after its siblings. Call through the DocRoom. */
export async function createTab(
  db: D1Database,
  input: {
    readonly docId: string;
    readonly parentTabId: string | null;
    readonly title: string;
    readonly markdown: string;
    readonly now: number;
  },
): Promise<Tab> {
  if (input.parentTabId !== null) {
    const parent = await getTab(db, input.parentTabId);
    if (parent.docId !== input.docId) throw new NotFoundError("tab");
  }
  const last = await db
    .prepare("SELECT MAX(position) AS position FROM tabs WHERE doc_id = ? AND parent_tab_id IS ?")
    .bind(input.docId, input.parentTabId)
    .first<{ position: number | null }>();
  const tab: Tab = {
    id: randomId(),
    docId: input.docId,
    parentTabId: input.parentTabId,
    position: (last?.position ?? -1) + 1,
    title: input.title,
    markdown: input.markdown,
    version: 1,
    updatedAt: input.now,
  };
  await db.batch([insertTabStatement(db, tab), touchDocStatement(db, input.docId, input.now)]);
  return tab;
}

export type TabWriteResult =
  | { readonly ok: true; readonly tab: Tab }
  | { readonly ok: false; readonly conflict: Tab };

/**
 * Applies a write only when the caller saw the current version. A stale
 * `baseVersion` returns the current tab so the caller can reload it. Call
 * through the DocRoom so the write is ordered and broadcast.
 */
export async function writeTab(
  db: D1Database,
  input: {
    readonly tabId: string;
    readonly baseVersion: number;
    readonly markdown?: string;
    readonly title?: string;
    readonly now: number;
  },
): Promise<TabWriteResult> {
  const updated = await db
    .prepare(
      `UPDATE tabs SET markdown = COALESCE(?, markdown), title = COALESCE(?, title),
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?
       RETURNING *`,
    )
    .bind(input.markdown ?? null, input.title ?? null, input.now, input.tabId, input.baseVersion)
    .first<TabRow>();
  if (!updated) return { ok: false, conflict: await getTab(db, input.tabId) };
  await touchDocStatement(db, updated.doc_id, input.now).run();
  return { ok: true, tab: toTab(updated) };
}

interface TabNode {
  id: string;
  parent_tab_id: string | null;
  position: number;
}

async function loadTabNodes(db: D1Database, docId: string): Promise<Array<TabNode>> {
  const { results } = await db
    .prepare("SELECT id, parent_tab_id, position FROM tabs WHERE doc_id = ? ORDER BY position")
    .bind(docId)
    .all<TabNode>();
  return results;
}

const siblingsOf = (nodes: ReadonlyArray<TabNode>, parentTabId: string | null) =>
  nodes
    .filter((node) => node.parent_tab_id === parentTabId)
    .toSorted((a, b) => a.position - b.position);

/**
 * Moves a tab (with its subtree) under `parentTabId` (null for top level) at
 * `position` among its new siblings. Both the old and new sibling groups are
 * renumbered 0..n-1. Returns the placements that changed, the moved tab first.
 * Call through the DocRoom.
 */
export async function moveTab(
  db: D1Database,
  input: {
    readonly tabId: string;
    readonly parentTabId: string | null;
    readonly position: number;
    readonly now: number;
  },
): Promise<ReadonlyArray<TabPlacement>> {
  const tab = await getTab(db, input.tabId);
  const nodes = await loadTabNodes(db, tab.docId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (let cursor = input.parentTabId; cursor !== null;) {
    if (cursor === tab.id) throw new InvalidMoveError();
    const node = byId.get(cursor);
    if (!node) throw new NotFoundError("tab");
    cursor = node.parent_tab_id;
  }

  const placements = new Map<string, TabPlacement>();
  const place = (group: ReadonlyArray<TabNode>, parentTabId: string | null) =>
    group.forEach((node, position) => {
      if (node.parent_tab_id !== parentTabId || node.position !== position) {
        placements.set(node.id, { tabId: node.id, parentTabId, position });
      }
    });
  const target = siblingsOf(nodes, input.parentTabId).filter((node) => node.id !== tab.id);
  const index = Math.max(0, Math.min(Math.trunc(input.position), target.length));
  const moved = byId.get(tab.id)!;
  target.splice(index, 0, moved);
  if (tab.parentTabId !== input.parentTabId) {
    place(
      siblingsOf(nodes, tab.parentTabId).filter((node) => node.id !== tab.id),
      tab.parentTabId,
    );
  }
  place(target, input.parentTabId);
  if (placements.size === 0) return [];

  await db.batch([
    ...[...placements.values()].map((placement) =>
      db
        .prepare("UPDATE tabs SET parent_tab_id = ?, position = ? WHERE id = ?")
        .bind(placement.parentTabId, placement.position, placement.tabId),
    ),
    touchDocStatement(db, tab.docId, input.now),
  ]);
  const own = placements.get(tab.id);
  return own
    ? [own, ...[...placements.values()].filter((p) => p !== own)]
    : [...placements.values()];
}

/**
 * Deletes a tab and all its descendants, then closes the gap among its
 * siblings. Returns the deleted ids and the sibling placements that changed.
 * Call through the DocRoom.
 */
export async function deleteTab(
  db: D1Database,
  input: { readonly tabId: string; readonly now: number },
): Promise<{
  readonly deletedTabIds: ReadonlyArray<string>;
  readonly placements: ReadonlyArray<TabPlacement>;
}> {
  const tab = await getTab(db, input.tabId);
  const nodes = await loadTabNodes(db, tab.docId);
  if (tab.parentTabId === null && siblingsOf(nodes, null).length <= 1) {
    throw new LastTabError();
  }
  const deleted = new Set([tab.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const node of nodes) {
      if (node.parent_tab_id !== null && deleted.has(node.parent_tab_id) && !deleted.has(node.id)) {
        deleted.add(node.id);
        grew = true;
      }
    }
  }
  const placements: Array<TabPlacement> = [];
  siblingsOf(nodes, tab.parentTabId)
    .filter((node) => node.id !== tab.id)
    .forEach((node, position) => {
      if (node.position !== position) {
        placements.push({ tabId: node.id, parentTabId: tab.parentTabId, position });
      }
    });
  const ids = [...deleted];
  await db.batch([
    // D1 enforces foreign keys, so ON DELETE CASCADE removes the descendants.
    db.prepare("DELETE FROM tabs WHERE id = ?").bind(tab.id),
    ...placements.map((placement) =>
      db
        .prepare("UPDATE tabs SET position = ? WHERE id = ?")
        .bind(placement.position, placement.tabId),
    ),
    touchDocStatement(db, tab.docId, input.now),
  ]);
  return { deletedTabIds: ids, placements };
}
