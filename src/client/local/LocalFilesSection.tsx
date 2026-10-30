import { localDocAppPath, type LocalDocSummary } from "../../host/docsCloudLocal.ts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ChevronDownIcon, DocIcon, FolderIcon, PlusIcon } from "../home/icons.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { navigate } from "../router.ts";
import { buildFileTree, matchesFileQuery, visibleFileRows } from "./fileTree.ts";
import { hostClient, useLocalCreateAvailable } from "./hostClient.ts";

import "./localFiles.css";

const EXPANDED_KEY = "docs-cloud:local-files-expanded";

function readExpanded(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((path) => typeof path === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(expanded: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    // Storage may be blocked; folders then just start collapsed next time.
  }
}

/**
 * The T3 Code project's markdown files as a folder tree, on the home page when
 * UP Docs runs inside T3 Code. They open on the local route and are never
 * sent to the UP Docs worker.
 */
export function LocalFilesSection(props: { readonly query: string }) {
  const [files, setFiles] = useState<ReadonlyArray<LocalDocSummary> | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(readExpanded);
  const canCreate = useLocalCreateAvailable();

  const reload = useCallback(async () => {
    try {
      setFiles((await hostClient.request({ kind: "files.list" })).files);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    return hostClient.onFilesChanged(() => void reload());
  }, [reload]);

  const query = props.query.trim().toLowerCase();
  const tree = useMemo(
    () => buildFileTree((files ?? []).filter((file) => !query || matchesFileQuery(file, query))),
    [files, query],
  );
  const rows = useMemo(
    () => visibleFileRows(tree, expanded, query !== ""),
    [tree, expanded, query],
  );

  const toggleFolder = (path: string) => {
    const next = new Set(expanded);
    if (!next.delete(path)) next.add(path);
    setExpanded(next);
    writeExpanded(next);
  };

  if (files === null && !failed) return null;

  const createFile = async (title: string) => {
    const file = await hostClient.request({ kind: "file.create", title });
    navigate(localDocAppPath(file.path));
  };

  return (
    <section className="local-files" aria-label="Project files">
      <div className="local-files-head">
        <h2 className="home-section-label">Project files</h2>
        {canCreate ? (
          <button type="button" className="local-files-new" onClick={() => setCreating(true)}>
            <PlusIcon size={14} />
            New file
          </button>
        ) : null}
      </div>
      {failed && files === null ? (
        <p className="home-empty">
          Could not list this project's files.{" "}
          <button type="button" className="link-button" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      ) : rows.length === 0 ? (
        <p className="home-empty">
          {query
            ? `No project files match "${props.query.trim()}".`
            : "No markdown files in this project yet."}
        </p>
      ) : (
        <ul className="local-files-tree">
          {rows.map((row) =>
            row.kind === "folder" ? (
              <li key={`folder:${row.folder.path}`}>
                <button
                  type="button"
                  className="local-folder"
                  style={{ paddingLeft: `${0.6 + row.depth * 1.25}rem` }}
                  aria-expanded={row.open}
                  disabled={query !== ""}
                  onClick={() => toggleFolder(row.folder.path)}
                >
                  <span className="local-folder-chevron" data-open={row.open || undefined}>
                    <ChevronDownIcon size={14} />
                  </span>
                  <FolderIcon size={16} />
                  <span className="local-file-title">{row.folder.name}</span>
                  <span className="local-folder-count">{row.folder.fileCount}</span>
                </button>
              </li>
            ) : (
              <li key={row.file.path}>
                <a
                  href={localDocAppPath(row.file.path)}
                  className="local-file"
                  style={{ paddingLeft: `${0.6 + row.depth * 1.25}rem` }}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(localDocAppPath(row.file.path));
                  }}
                >
                  <span className="local-folder-chevron" />
                  <DocIcon size={16} />
                  <span className="local-file-title">{row.file.title}</span>
                  <span className="local-file-path">{row.file.path}</span>
                  {row.file.cloudDocId ? (
                    <span className="local-file-badge">In UP Docs</span>
                  ) : null}
                </a>
              </li>
            ),
          )}
        </ul>
      )}
      {creating ? (
        <TitleDialog
          heading="New project file"
          detail="A markdown file in this project's docs/ folder"
          initial=""
          submitLabel="Create"
          onSubmit={createFile}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </section>
  );
}
