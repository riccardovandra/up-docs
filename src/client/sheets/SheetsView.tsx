import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

import type { SheetMeta } from "../../shared/sheets.ts";
import type { Project } from "../../shared/protocol.ts";
import { formatDay, type HomeView, type ProjectScope } from "../home/homeLogic.ts";
import { GridIcon, ListIcon, MoreIcon, PlusIcon } from "../home/icons.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../home/Menu.tsx";
import { NoProjectBadge, ProjectBadge } from "../home/ProjectSwitcher.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { navigate } from "../router.ts";
import { diagramsInScope } from "../diagrams/DiagramsView.tsx";
import { sheetPath, sheetsApi } from "./sheetsApi.ts";
import { SheetIcon } from "./SheetIcon.tsx";
import "./sheets-library.css";

const VIEW_KEY = "up-docs.sheets.view";

function storedView(): HomeView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

/**
 * The library's Sheets view: a grid with a "New sheet" tile, or a list. The
 * library page gives it the project scope, as it does the Diagrams view.
 */
export function SheetsView(props: {
  readonly scope: ProjectScope;
  /** The scope's name, or null when every project shows. */
  readonly scopeLabel: string | null;
  readonly projects: ReadonlyArray<Project>;
  /** Where a new sheet is filed, in words. */
  readonly createIn: string;
  readonly resolveProjectId: () => Promise<string | null>;
}) {
  const [sheets, setSheets] = useState<ReadonlyArray<SheetMeta> | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<HomeView>(storedView);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<SheetMeta | null>(null);

  const reload = useCallback(async () => {
    try {
      setSheets(await sheetsApi.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = useMemo(
    () => diagramsInScope(sheets ?? [], props.scope, props.projects),
    [sheets, props.scope, props.projects],
  );
  const projectOf = useMemo(
    () => new Map(props.projects.map((project) => [project.id, project])),
    [props.projects],
  );

  const toggleView = () => {
    const next = view === "grid" ? "list" : "grid";
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Remembering is a convenience.
    }
  };

  const create = async (title: string) => {
    const projectId = await props.resolveProjectId();
    const created = await sheetsApi.create({ projectId, title });
    navigate(sheetPath(created.sheet.id));
  };

  const remove = (sheet: SheetMeta) => {
    if (!window.confirm(`Delete "${sheet.title}" for everyone? Its tabs and cells go too.`)) return;
    void sheetsApi.remove(sheet.id).then(reload, reload);
  };

  const actions = (sheet: SheetMeta) => (
    <Menu label={`${sheet.title} options`} trigger={<MoreIcon size={16} />} triggerClassName="home-icon-button sheet-card-more" align="end">
      {(close) => (
        <>
          <MenuItem
            onSelect={() => {
              close();
              setRenaming(sheet);
            }}
          >
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Move to</MenuLabel>
          <div className="home-menu-scroll">
            {props.projects.map((project) => (
              <MenuItem
                key={project.id}
                kind="radio"
                checked={sheet.projectId === project.id}
                icon={<ProjectBadge name={project.name} />}
                onSelect={() => {
                  close();
                  void sheetsApi.move(sheet.id, project.id).then(reload, reload);
                }}
              >
                {project.name}
              </MenuItem>
            ))}
          </div>
          <MenuItem
            kind="radio"
            checked={sheet.projectId === null}
            icon={<NoProjectBadge />}
            onSelect={() => {
              close();
              void sheetsApi.move(sheet.id, null).then(reload, reload);
            }}
          >
            No project
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            onSelect={() => {
              close();
              remove(sheet);
            }}
          >
            Delete
          </MenuItem>
        </>
      )}
    </Menu>
  );

  if (failed && !sheets) {
    return (
      <>
        <p className="error">Could not load your sheets.</p>
        <button type="button" className="button secondary" onClick={() => void reload()}>
          Try again
        </button>
      </>
    );
  }
  if (!sheets) return null;

  const newDetail = `In ${props.createIn}`;
  return (
    <>
      <div className="home-toolbar">
        <div className="home-tabs" role="tablist" aria-label="Which sheets">
          <button type="button" role="tab" aria-selected="true" className="home-tab">
            All<span className="diagram-count">{shown.length}</span>
          </button>
        </div>
        <div className="home-controls">
          <button
            type="button"
            className="home-icon-button"
            aria-label={view === "grid" ? "Show as list" : "Show as grid"}
            onClick={toggleView}
          >
            {view === "grid" ? <ListIcon /> : <GridIcon />}
          </button>
          <button type="button" className="button diagram-new-button" onClick={() => setCreating(true)}>
            <PlusIcon size={16} />
            New sheet
          </button>
        </div>
      </div>

      {view === "grid" ? (
        <div className="doc-grid">
          <button type="button" className="doc-card doc-card-new" onClick={() => setCreating(true)}>
            <span className="doc-card-paper doc-card-new-paper" aria-hidden="true">
              <PlusIcon size={46} />
            </span>
            <span className="doc-card-footer">
              <span className="doc-card-icon">
                <SheetIcon size={18} />
              </span>
              <span className="doc-card-text">
                <span className="doc-card-title">New sheet</span>
                <span className="doc-card-meta">{newDetail}</span>
              </span>
            </span>
          </button>
          {shown.map((sheet) => (
            <article key={sheet.id} className="doc-card sheet-card">
              <a href={sheetPath(sheet.id)} className="doc-card-link" onClick={follow(sheetPath(sheet.id))}>
                <span className="sheet-card-cover" aria-hidden="true">
                  <span className="sheet-card-grid" />
                </span>
                <span className="doc-card-footer">
                  <span className="doc-card-icon">
                    <SheetIcon size={18} />
                  </span>
                  <span className="doc-card-text">
                    <span className="doc-card-title">{sheet.title}</span>
                    <span className="doc-card-meta">Edited {formatDay(sheet.updatedAt)}</span>
                  </span>
                </span>
              </a>
              {actions(sheet)}
            </article>
          ))}
        </div>
      ) : (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Sheet</th>
              <th>Project</th>
              <th>Edited</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            <tr className="doc-row doc-row-new">
              <td className="doc-row-title" colSpan={4}>
                <button type="button" onClick={() => setCreating(true)}>
                  <PlusIcon size={16} />
                  <span>New sheet</span>
                  <span className="doc-row-muted">{newDetail}</span>
                </button>
              </td>
            </tr>
            {shown.map((sheet) => {
              const project = sheet.projectId ? projectOf.get(sheet.projectId) : undefined;
              return (
                <tr key={sheet.id} className="doc-row" onClick={() => navigate(sheetPath(sheet.id))}>
                  <td className="doc-row-title">
                    <a href={sheetPath(sheet.id)} onClick={follow(sheetPath(sheet.id))}>
                      <SheetIcon size={16} />
                      <span className="doc-row-title-text">
                        <span>{sheet.title}</span>
                      </span>
                    </a>
                  </td>
                  <td>
                    <span className="doc-row-project">
                      {project ? <ProjectBadge name={project.name} /> : <NoProjectBadge />}
                      <span>{project?.name ?? "No project"}</span>
                    </span>
                  </td>
                  <td className="doc-row-muted">{formatDay(sheet.updatedAt)}</td>
                  <td className="doc-row-actions" onClick={(event) => event.stopPropagation()}>
                    {actions(sheet)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {shown.length === 0 ? (
        <p className="home-empty">
          {props.scopeLabel ? `No sheets in ${props.scopeLabel} yet.` : "No sheets yet. Start one with New sheet."}
        </p>
      ) : null}

      {creating ? (
        <TitleDialog
          heading="New sheet"
          detail={newDetail}
          initial=""
          submitLabel="Create"
          onSubmit={create}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {renaming ? (
        <TitleDialog
          heading="Rename sheet"
          detail={null}
          initial={renaming.title}
          submitLabel="Rename"
          onSubmit={async (title) => {
            if (title !== renaming.title) await sheetsApi.rename(renaming.id, title);
            await reload();
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
    </>
  );
}
