// Folders on the home page: a tree inside one project, shared by its docs,
// diagrams and sheets. Wire types for `/api/folders`, and the tree helpers the
// home page uses.

/** The three kinds of item a folder holds. */
export type FolderItemKind = "doc" | "diagram" | "sheet";

export const FOLDER_ITEM_KINDS: ReadonlyArray<FolderItemKind> = ["doc", "diagram", "sheet"];

export const isFolderItemKind = (value: unknown): value is FolderItemKind =>
  typeof value === "string" && (FOLDER_ITEM_KINDS as ReadonlyArray<string>).includes(value);

/** The longest folder name. */
export const MAX_FOLDER_NAME_LENGTH = 80;

export interface Folder {
  readonly id: string;
  readonly projectId: string;
  /** Null for a folder at the project's top. */
  readonly parentId: string | null;
  readonly name: string;
  readonly createdAt: number;
}

/** Which folder an item is in. Items in no folder are not listed. */
export interface FolderPlacement {
  readonly kind: FolderItemKind;
  readonly id: string;
  readonly folderId: string;
}

/**
 * `GET /api/folders?projectId=`. The admin gets every folder; anyone else only
 * the folders on the way to an item they can open, and only those items' places.
 */
export interface ProjectFolders {
  readonly folders: ReadonlyArray<Folder>;
  readonly placements: ReadonlyArray<FolderPlacement>;
}

/** `POST /api/folders` body. */
export interface CreateFolderRequest {
  readonly projectId: string;
  readonly parentId: string | null;
  readonly name: string;
}

/** `POST /api/folders/place` body: null `folderId` takes the item out of any folder. */
export interface PlaceItemRequest {
  readonly kind: FolderItemKind;
  readonly id: string;
  readonly folderId: string | null;
}

/** Folders under `parentId` (null for the top), by name. */
export function childFolders(
  folders: ReadonlyArray<Folder>,
  parentId: string | null,
): ReadonlyArray<Folder> {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** The folders from the top down to `folderId`, itself included; empty for null or unknown. */
export function folderPath(
  folders: ReadonlyArray<Folder>,
  folderId: string | null,
): ReadonlyArray<Folder> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: Array<Folder> = [];
  let current = folderId === null ? undefined : byId.get(folderId);
  // A cycle cannot be made through the API; the bound only guards bad data.
  while (current && path.length <= folders.length) {
    path.unshift(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}

/** `folderId` and every folder under it, at any depth. */
export function folderAndDescendants(
  folders: ReadonlyArray<Folder>,
  folderId: string,
): ReadonlySet<string> {
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}
