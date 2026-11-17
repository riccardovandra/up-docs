// Folders inside a project, shared by its docs, diagrams and sheets. Only the
// admin creates, renames, deletes folders and files items in them, like
// projects. Anyone who can see the project reads the folders that lead to items
// they can open (see listProjectFolders).

import {
  MAX_FOLDER_NAME_LENGTH,
  type Folder,
  type FolderItemKind,
  type FolderPlacement,
  type ProjectFolders,
} from "../shared/folders.ts";

interface FolderRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  created_at: number;
}

const toFolder = (row: FolderRow): Folder => ({
  id: row.id,
  projectId: row.project_id,
  parentId: row.parent_id,
  name: row.name,
  createdAt: row.created_at,
});

const COLUMNS = "id, project_id, parent_id, name, created_at";

const ITEM_TABLE: Readonly<Record<FolderItemKind, string>> = {
  doc: "docs",
  diagram: "diagrams",
  sheet: "sheets",
};

/** A folder name from the wire: trimmed text, or null when blank, not text or too long. */
export function folderNameArg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length > 0 && name.length <= MAX_FOLDER_NAME_LENGTH ? name : null;
}

export async function getFolder(db: D1Database, folderId: string): Promise<Folder | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM folders WHERE id = ?`)
    .bind(folderId)
    .first<FolderRow>();
  return row ? toFolder(row) : null;
}

/**
 * A project's folders and where its items sit. With `all` (the admin) every
 * folder and placement; otherwise only the items `userId` can open (docs and
 * diagrams they are a member of, sheets they created) and the folders on the
 * way to them, so a guest never learns names of folders holding nothing of theirs.
 */
export async function listProjectFolders(
  db: D1Database,
  input: { readonly projectId: string; readonly userId: string; readonly all: boolean },
): Promise<ProjectFolders> {
  const all = input.all ? 1 : 0;
  const [placed, folders] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT 'doc' AS kind, d.id, d.folder_id FROM docs d
         WHERE d.project_id = ?1 AND d.folder_id IS NOT NULL
           AND (?3 OR EXISTS (SELECT 1 FROM doc_members m WHERE m.doc_id = d.id AND m.user_id = ?2))
         UNION ALL
         SELECT 'diagram', g.id, g.folder_id FROM diagrams g
         WHERE g.project_id = ?1 AND g.folder_id IS NOT NULL
           AND (?3 OR EXISTS (SELECT 1 FROM diagram_members m WHERE m.diagram_id = g.id AND m.user_id = ?2))
         UNION ALL
         SELECT 'sheet', s.id, s.folder_id FROM sheets s
         WHERE s.project_id = ?1 AND s.folder_id IS NOT NULL AND (?3 OR s.created_by = ?2)`,
      )
      .bind(input.projectId, input.userId, all),
    db
      .prepare(`SELECT ${COLUMNS} FROM folders WHERE project_id = ? ORDER BY name, id`)
      .bind(input.projectId),
  ]);
  const placements = ((placed?.results ?? []) as unknown as Array<{
    kind: FolderItemKind;
    id: string;
    folder_id: string;
  }>).map((row): FolderPlacement => ({ kind: row.kind, id: row.id, folderId: row.folder_id }));
  const every = ((folders?.results ?? []) as unknown as Array<FolderRow>).map(toFolder);
  if (input.all) return { folders: every, placements };

  const byId = new Map(every.map((folder) => [folder.id, folder]));
  const shown = new Set<string>();
  for (const placement of placements) {
    let current = byId.get(placement.folderId);
    while (current && !shown.has(current.id)) {
      shown.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  return { folders: every.filter((folder) => shown.has(folder.id)), placements };
}

export type CreateFolderResult =
  | { readonly ok: true; readonly folder: Folder }
  | { readonly ok: false; readonly error: "project_not_found" | "parent_not_found" };

/** A new folder at the project's top, or under `parentId` (which must be in the same project). */
export async function createFolder(
  db: D1Database,
  input: {
    readonly projectId: string;
    readonly parentId: string | null;
    readonly name: string;
    readonly now: number;
  },
): Promise<CreateFolderResult> {
  const project = await db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .bind(input.projectId)
    .first();
  if (!project) return { ok: false, error: "project_not_found" };
  if (input.parentId !== null) {
    const parent = await getFolder(db, input.parentId);
    if (!parent || parent.projectId !== input.projectId) {
      return { ok: false, error: "parent_not_found" };
    }
  }
  const folder: Folder = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    parentId: input.parentId,
    name: input.name,
    createdAt: input.now,
  };
  await db
    .prepare(`INSERT INTO folders (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`)
    .bind(folder.id, folder.projectId, folder.parentId, folder.name, folder.createdAt)
    .run();
  return { ok: true, folder };
}

export async function renameFolder(
  db: D1Database,
  input: { readonly folderId: string; readonly name: string },
): Promise<Folder | null> {
  const row = await db
    .prepare(`UPDATE folders SET name = ? WHERE id = ? RETURNING ${COLUMNS}`)
    .bind(input.name, input.folderId)
    .first<FolderRow>();
  return row ? toFolder(row) : null;
}

/**
 * Deletes a folder but never what is in it: its items and subfolders move up
 * to its parent (the project's top for a top-level folder). False when unknown.
 */
export async function deleteFolder(db: D1Database, folderId: string): Promise<boolean> {
  const folder = await getFolder(db, folderId);
  if (!folder) return false;
  await db.batch([
    ...Object.values(ITEM_TABLE).map((table) =>
      db
        .prepare(`UPDATE ${table} SET folder_id = ?1 WHERE folder_id = ?2`)
        .bind(folder.parentId, folder.id),
    ),
    db
      .prepare("UPDATE folders SET parent_id = ?1 WHERE parent_id = ?2")
      .bind(folder.parentId, folder.id),
    db.prepare("DELETE FROM folders WHERE id = ?").bind(folder.id),
  ]);
  return true;
}

export type PlaceItemResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "item_not_found" | "folder_not_found" };

/**
 * Files an item in a folder of its own project, or in none (null). The item's
 * updated time is left alone: filing is not an edit.
 */
export async function placeItem(
  db: D1Database,
  input: { readonly kind: FolderItemKind; readonly id: string; readonly folderId: string | null },
): Promise<PlaceItemResult> {
  const table = ITEM_TABLE[input.kind];
  const item = await db
    .prepare(`SELECT project_id FROM ${table} WHERE id = ?`)
    .bind(input.id)
    .first<{ project_id: string | null }>();
  if (!item) return { ok: false, error: "item_not_found" };
  if (input.folderId !== null) {
    const folder = await getFolder(db, input.folderId);
    if (!folder || folder.projectId !== item.project_id) {
      return { ok: false, error: "folder_not_found" };
    }
  }
  await db
    .prepare(`UPDATE ${table} SET folder_id = ? WHERE id = ?`)
    .bind(input.folderId, input.id)
    .run();
  return { ok: true };
}
