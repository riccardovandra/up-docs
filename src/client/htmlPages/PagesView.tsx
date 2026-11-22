import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { pagePath, type PageListItem } from "../../shared/htmlPages.ts";
import type { Project } from "../../shared/protocol.ts";
import { diagramsInScope } from "../diagrams/DiagramsView.tsx";
import { formatDay, type ProjectScope } from "../home/homeLogic.ts";
import { MoreIcon, PlusIcon } from "../home/icons.tsx";
import {
  FolderCell,
  FolderHead,
  FolderHeaderCell,
  FolderRows,
  MoveToFolderItem,
} from "../home/folders/FolderUi.tsx";
import { useFolderItems, useFolders } from "../home/folders/folderState.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../home/Menu.tsx";
import { NoProjectBadge, ProjectBadge } from "../home/ProjectSwitcher.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { navigate } from "../router.ts";
import { PageIcon } from "./PageIcon.tsx";
import { formatBytes, pagesApi, titleFromFile, uploadErrorText } from "./pagesApi.ts";
import "./pages.css";

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

/** The docs a page is shown in, each once. */
const docCount = (page: PageListItem) => new Set(page.uses.map((use) => use.docId)).size;

/**
 * The library's Pages view: uploaded HTML prototypes in one dense table. A
 * new page comes from an .html file on the person's machine.
 */
export function PagesView(props: {
  readonly scope: ProjectScope;
  /** The scope's name, or null when every project shows. */
  readonly scopeLabel: string | null;
  readonly projects: ReadonlyArray<Project>;
  /** Where a new page is filed, in words. */
  readonly createIn: string;
  readonly resolveProjectId: () => Promise<string | null>;
}) {
  const [pages, setPages] = useState<ReadonlyArray<PageListItem> | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<PageListItem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setPages(await pagesApi.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const inScope = useMemo(
    () => diagramsInScope(pages ?? [], props.scope, props.projects),
    [pages, props.scope, props.projects],
  );
  const folders = useFolders();
  useFolderItems("page", inScope);
  const shown = useMemo(() => folders.filter("page", inScope), [folders, inScope]);
  const projectOf = useMemo(
    () => new Map(props.projects.map((project) => [project.id, project])),
    [props.projects],
  );

  const create = async (file: File) => {
    setBusy(true);
    setNotice(null);
    try {
      const projectId = await props.resolveProjectId();
      const page = await pagesApi.create({ title: titleFromFile(file), projectId, file });
      const target = folders.canManage ? (folders.at?.id ?? null) : null;
      if (target !== null && projectId !== null) await folders.place("page", page.id, target);
      navigate(pagePath(page.id));
    } catch (cause) {
      setNotice(uploadErrorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = (page: PageListItem) => {
    if (!window.confirm(`Delete "${page.title}" and all its versions for everyone?`)) return;
    void pagesApi.remove(page.id).then(reload, reload);
  };

  const actions = (page: PageListItem) => (
    <Menu label={`${page.title} options`} trigger={<MoreIcon size={16} />} align="end">
      {(close) => (
        <>
          {page.role === "owner" || page.role === "editor" ? (
            <MenuItem
              onSelect={() => {
                close();
                setRenaming(page);
              }}
            >
              Rename
            </MenuItem>
          ) : null}
          <MoveToFolderItem kind="page" id={page.id} title={page.title} close={close} />
          {page.role === "owner" ? (
            <>
              <MenuSeparator />
              <MenuLabel>Move to</MenuLabel>
              <div className="home-menu-scroll">
                {props.projects.map((project) => (
                  <MenuItem
                    key={project.id}
                    kind="radio"
                    checked={page.projectId === project.id}
                    icon={<ProjectBadge name={project.name} />}
                    onSelect={() => {
                      close();
                      void pagesApi.move(page.id, project.id).then(reload, reload);
                    }}
                  >
                    {project.name}
                  </MenuItem>
                ))}
              </div>
              <MenuItem
                kind="radio"
                checked={page.projectId === null}
                icon={<NoProjectBadge />}
                onSelect={() => {
                  close();
                  void pagesApi.move(page.id, null).then(reload, reload);
                }}
              >
                No project
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  close();
                  remove(page);
                }}
              >
                Delete
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );

  if (failed && !pages) {
    return (
      <>
        <p className="error">Could not load your pages.</p>
        <button type="button" className="button secondary" onClick={() => void reload()}>
          Try again
        </button>
      </>
    );
  }
  if (!pages) return null;

  const columns = folders.active ? 7 : 6;
  const newDetail = `In ${props.createIn}`;
  return (
    <>
      <div className="home-toolbar">
        <div className="home-tabs" role="tablist" aria-label="Which pages">
          <button type="button" role="tab" aria-selected="true" className="home-tab">
            All<span className="diagram-count">{inScope.length}</span>
          </button>
        </div>
        <div className="home-controls">
          <button
            type="button"
            className="button diagram-new-button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <PlusIcon size={16} />
            {busy ? "Uploading…" : "Upload page"}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".html,.htm,text/html"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void create(file);
            }}
          />
        </div>
      </div>

      {notice ? (
        <div className="notice" role="status">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <FolderHead kind="page" count={shown.length} />

      <table className="doc-table page-table">
        <thead>
          <tr>
            <th>Page</th>
            <th>Project</th>
            <FolderHeaderCell />
            <th>Version</th>
            <th>Shown in</th>
            <th>Edited</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          <tr className="doc-row doc-row-new">
            <td className="doc-row-title" colSpan={columns}>
              <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
                <PlusIcon size={16} />
                <span>Upload an HTML file</span>
                <span className="doc-row-muted">{newDetail}</span>
              </button>
            </td>
          </tr>
          <FolderRows kind="page" columns={columns} />
          {shown.map((page) => {
            const project = page.projectId ? projectOf.get(page.projectId) : undefined;
            const docs = docCount(page);
            return (
              <tr
                key={page.id}
                className="doc-row"
                onClick={() => navigate(pagePath(page.id))}
                {...folders.dragProps("page", page.id)}
              >
                <td className="doc-row-title">
                  <a href={pagePath(page.id)} onClick={follow(pagePath(page.id))}>
                    <PageIcon size={16} />
                    <span className="doc-row-title-text">
                      <span>{page.title}</span>
                    </span>
                  </a>
                </td>
                <td>
                  <span className="doc-row-project">
                    {project ? <ProjectBadge name={project.name} /> : <NoProjectBadge />}
                    <span>{project?.name ?? "No project"}</span>
                  </span>
                </td>
                <FolderCell kind="page" id={page.id} />
                <td className="doc-row-muted">
                  v{page.version} · {formatBytes(page.bytes)}
                </td>
                <td className="doc-row-muted">
                  {docs === 0 ? "Not in a doc" : docs === 1 ? page.uses[0]!.docTitle : `${docs} docs`}
                </td>
                <td className="doc-row-muted">{formatDay(page.updatedAt)}</td>
                <td className="doc-row-actions" onClick={(event) => event.stopPropagation()}>
                  {actions(page)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {shown.length === 0 && !(folders.at && folders.subfolders.length > 0) ? (
        <p className="home-empty">
          {folders.at
            ? `No pages in ${folders.at.name} yet.`
            : props.scopeLabel
              ? `No pages in ${props.scopeLabel} yet.`
              : "No pages yet. Upload an HTML prototype to share it privately."}
        </p>
      ) : null}

      {renaming ? (
        <TitleDialog
          heading="Rename page"
          detail={null}
          initial={renaming.title}
          submitLabel="Rename"
          onSubmit={async (title) => {
            if (title !== renaming.title) await pagesApi.rename(renaming.id, title);
            await reload();
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
    </>
  );
}
