import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

import { canEdit as roleCanEdit } from "../../shared/access.ts";
import { designPath, designPictureUrl, type DesignListItem } from "../../shared/design.ts";
import type { Project } from "../../shared/protocol.ts";
import { diagramsInScope } from "../diagrams/DiagramsView.tsx";
import { useDiagramChanges } from "../diagrams/drawioEditing.ts";
import { formatDay, HOME_TABS, type HomeTab, type ProjectScope } from "../home/homeLogic.ts";
import { MoreIcon, PlusIcon } from "../home/icons.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../home/Menu.tsx";
import { NoProjectBadge, ProjectBadge } from "../home/ProjectSwitcher.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { useMe } from "../me.ts";
import { navigate } from "../router.ts";
import { DesignIcon } from "./DesignIcon.tsx";
import { designErrorText, designsApi } from "./designsApi.ts";
import "../diagrams/diagrams.css";
import "./designs.css";

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

/** A design's card picture, or a blank paper before its first save. */
export function DesignPicture(props: {
  readonly design: Pick<DesignListItem, "id" | "pictureVersion" | "title">;
  readonly className: string;
}) {
  const src = designPictureUrl(props.design);
  return (
    <span className={`design-picture ${props.className}`}>
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="design-picture-empty">No picture yet</span>
      )}
    </span>
  );
}

/**
 * The library's Designs view: cards with each design's picture and a "New
 * design" tile. All, yours, or shared with you, in the library's project scope.
 */
export function DesignsView(props: {
  readonly scope: ProjectScope;
  /** The scope's name, or null when every project shows. */
  readonly scopeLabel: string | null;
  readonly projects: ReadonlyArray<Project>;
  /** Where a new design is filed, in words. */
  readonly createIn: string;
  readonly resolveProjectId: () => Promise<string | null>;
}) {
  const me = useMe();
  const userId = me?.user.id ?? "";
  const [designs, setDesigns] = useState<ReadonlyArray<DesignListItem> | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<HomeTab>("all");
  const [renaming, setRenaming] = useState<DesignListItem | null>(null);
  /** False on a phone or tablet: the editor does not open there, so no New design. */
  const changesHere = useDiagramChanges();

  const reload = useCallback(async () => {
    try {
      setDesigns(await designsApi.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Back from a design page (or another tab): pictures and titles may have changed.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const inScope = useMemo(
    () => diagramsInScope(designs ?? [], props.scope, props.projects),
    [designs, props.scope, props.projects],
  );
  const shown = useMemo(
    () =>
      tab === "all"
        ? inScope
        : inScope.filter((design) => (design.createdBy === userId) === (tab === "yours")),
    [inScope, tab, userId],
  );
  const projectOf = useMemo(
    () => new Map(props.projects.map((project) => [project.id, project])),
    [props.projects],
  );

  const { resolveProjectId } = props;
  const create = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const design = await designsApi.create({ projectId: await resolveProjectId() });
      navigate(designPath(design.id));
    } catch (cause) {
      setNotice(designErrorText(cause));
      setBusy(false);
    }
  }, [resolveProjectId]);

  const act = (work: Promise<unknown>) =>
    void work.then(reload, (cause: unknown) => {
      setNotice(designErrorText(cause));
      void reload();
    });

  const remove = (design: DesignListItem) => {
    if (!window.confirm(`Delete "${design.title}" and all its versions for everyone?`)) return;
    act(designsApi.remove(design.id));
  };

  const actions = (design: DesignListItem) =>
    roleCanEdit(design.role) && changesHere ? (
      <Menu label={`Actions for ${design.title}`} trigger={<MoreIcon size={16} />} align="end">
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close();
                setRenaming(design);
              }}
            >
              Rename
            </MenuItem>
            {design.role === "owner" ? (
              <>
                <MenuSeparator />
                <MenuLabel>Move to</MenuLabel>
                <div className="home-menu-scroll">
                  {props.projects.map((project) => (
                    <MenuItem
                      key={project.id}
                      kind="radio"
                      checked={design.projectId === project.id}
                      icon={<ProjectBadge name={project.name} />}
                      onSelect={() => {
                        close();
                        act(designsApi.move(design.id, project.id));
                      }}
                    >
                      {project.name}
                    </MenuItem>
                  ))}
                </div>
                <MenuItem
                  kind="radio"
                  checked={design.projectId === null}
                  icon={<NoProjectBadge />}
                  onSelect={() => {
                    close();
                    act(designsApi.move(design.id, null));
                  }}
                >
                  No project
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={() => {
                    close();
                    remove(design);
                  }}
                >
                  Delete
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      </Menu>
    ) : null;

  if (failed && !designs) {
    return (
      <>
        <p className="error">Could not load your designs.</p>
        <button type="button" className="button secondary" onClick={() => void reload()}>
          Try again
        </button>
      </>
    );
  }
  if (!designs) return null;

  const emptyText =
    tab === "yours"
      ? "You have not created any designs here yet."
      : tab === "shared"
        ? "Nothing has been shared with you here yet."
        : props.scopeLabel
          ? `No designs in ${props.scopeLabel} yet.`
          : changesHere
            ? "No designs yet. Start one with New design."
            : "No designs yet.";

  return (
    <>
      <div className="home-toolbar">
        <div className="home-tabs" role="tablist" aria-label="Whose designs">
          {HOME_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="home-tab"
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.id === "all" ? <span className="diagram-count">{inScope.length}</span> : null}
            </button>
          ))}
        </div>
        <div className="home-controls">
          {changesHere ? (
            <button
              type="button"
              className="button diagram-new-button"
              disabled={busy}
              onClick={() => void create()}
            >
              <PlusIcon size={16} />
              New design
            </button>
          ) : null}
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

      <div className="doc-grid">
        {changesHere && tab !== "shared" ? (
          <button
            type="button"
            className="doc-card doc-card-new"
            disabled={busy}
            onClick={() => void create()}
          >
            <span className="doc-card-paper doc-card-new-paper" aria-hidden="true">
              <PlusIcon size={46} />
            </span>
            <span className="doc-card-footer">
              <span className="doc-card-icon">
                <DesignIcon size={18} />
              </span>
              <span className="doc-card-text">
                <span className="doc-card-title">New design</span>
                <span className="doc-card-meta">In {props.createIn}, opens the editor</span>
              </span>
            </span>
          </button>
        ) : null}
        {shown.map((design) => {
          const project = design.projectId ? projectOf.get(design.projectId) : undefined;
          return (
            <article key={design.id} className="doc-card">
              <a
                href={designPath(design.id)}
                className="doc-card-link"
                onClick={follow(designPath(design.id))}
              >
                <DesignPicture design={design} className="design-card-cover" />
                <span className="doc-card-footer">
                  <span className="doc-card-icon">
                    <DesignIcon size={18} />
                  </span>
                  <span className="doc-card-text">
                    <span className="doc-card-title">{design.title}</span>
                    <span className="doc-card-meta diagram-card-meta">
                      {props.scope.kind === "all" ? (
                        <span className="doc-row-project">
                          {project ? <ProjectBadge name={project.name} /> : <NoProjectBadge />}
                          <span>{project?.name ?? "No project"}</span>
                        </span>
                      ) : null}
                      <span>{formatDay(design.updatedAt)}</span>
                    </span>
                  </span>
                </span>
              </a>
              {actions(design) ? <div className="doc-card-menu">{actions(design)}</div> : null}
            </article>
          );
        })}
      </div>

      {shown.length === 0 ? <p className="home-empty">{emptyText}</p> : null}

      {renaming ? (
        <TitleDialog
          heading="Rename design"
          detail={null}
          initial={renaming.title}
          submitLabel="Rename"
          onSubmit={async (title) => {
            if (title !== renaming.title) await designsApi.rename(renaming.id, title);
            await reload();
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
    </>
  );
}
