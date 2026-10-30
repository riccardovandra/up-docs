import type { LocalDocSummary } from "../../host/docsCloudLocal.ts";

export interface FileTreeFolder {
  readonly name: string;
  readonly path: string;
  readonly folders: ReadonlyArray<FileTreeFolder>;
  readonly files: ReadonlyArray<LocalDocSummary>;
  /** Files anywhere below this folder. */
  readonly fileCount: number;
}

export type FileTreeRow =
  | {
      readonly kind: "folder";
      readonly folder: FileTreeFolder;
      readonly depth: number;
      readonly open: boolean;
    }
  | { readonly kind: "file"; readonly file: LocalDocSummary; readonly depth: number };

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: Array<LocalDocSummary>;
}

const byName = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

function freeze(folder: MutableFolder): FileTreeFolder {
  const folders = [...folder.folders.values()]
    .toSorted((left, right) => byName(left.name, right.name))
    .map(freeze);
  const files = folder.files.toSorted((left, right) => byName(left.path, right.path));
  return {
    name: folder.name,
    path: folder.path,
    folders,
    files,
    fileCount: files.length + folders.reduce((sum, child) => sum + child.fileCount, 0),
  };
}

/** Files nested by their `/`-separated folders; each level lists folders, then files. */
export function buildFileTree(files: ReadonlyArray<LocalDocSummary>): FileTreeFolder {
  const root: MutableFolder = { name: "", path: "", folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    let folder = root;
    for (const name of segments.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let child = folder.folders.get(name);
      if (!child) {
        child = { name, path, folders: new Map(), files: [] };
        folder.folders.set(name, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  return freeze(root);
}

export function matchesFileQuery(file: LocalDocSummary, query: string): boolean {
  return file.title.toLowerCase().includes(query) || file.path.toLowerCase().includes(query);
}

/**
 * The rows to render, top to bottom. Folders open when their path is in
 * `expanded`, or always while searching, since the tree then holds only matches.
 */
export function visibleFileRows(
  tree: FileTreeFolder,
  expanded: ReadonlySet<string>,
  searching: boolean,
): ReadonlyArray<FileTreeRow> {
  const rows: Array<FileTreeRow> = [];
  const walk = (folder: FileTreeFolder, depth: number) => {
    for (const child of folder.folders) {
      const open = searching || expanded.has(child.path);
      rows.push({ kind: "folder", folder: child, depth, open });
      if (open) walk(child, depth + 1);
    }
    for (const file of folder.files) rows.push({ kind: "file", file, depth });
  };
  walk(tree, 0);
  return rows;
}
