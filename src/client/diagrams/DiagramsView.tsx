import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { diagramPath, type DiagramListItem } from "../../shared/drawio.ts";
import type { Project } from "../../shared/protocol.ts";
import { formatDay, type HomeView, type ProjectScope } from "../home/homeLogic.ts";
import {
  DiagramIcon,
  DocIcon,
  GridIcon,
  LinkIcon,
  ListIcon,
  PenIcon,
  PlusIcon,
} from "../home/icons.tsx";
import { NoProjectBadge, ProjectBadge } from "../home/ProjectSwitcher.tsx";
import { navigate } from "../router.ts";
import { SheetIcon } from "../sheets/SheetIcon.tsx";
import { DiagramEditor, type DiagramEditorTarget } from "./DiagramEditor.tsx";
import { DiagramPicture } from "./DiagramPicture.tsx";
import { subscribeRefresh } from "./diagramRefresh.ts";
import { diagramsApi } from "./diagramsApi.ts";
import "./diagrams.css";

export type LibraryKind = "docs" | "diagrams" | "sheets";

/** The switch in the library's title row: the docs, the diagrams or the sheets. */
export function LibraryKindSwitch(props: { readonly kind: LibraryKind }) {
  const option = (kind: LibraryKind, path: string, label: string, icon: ReactNode) => (
    <button
      type="button"
      className="library-kind-option"
      aria-pressed={props.kind === kind}
      onClick={() => navigate(path)}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div className="library-kind" role="group" aria-label="Show">
      {option("docs", "/", "Docs", <DocIcon size={16} />)}
      {option("diagrams", "/diagrams", "Diagrams", <DiagramIcon size={16} />)}
      {option("sheets", "/sheets", "Sheets", <SheetIcon size={16} />)}
    </div>
  );
}

const VIEW_KEY = "up-docs.diagrams.view";

function storedView(): HomeView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The docs a diagram is linked in, each once, in the order the server gave. */
function linkedDocs(diagram: DiagramListItem): ReadonlyArray<string> {
  const titles = new Map<string, string>();
  for (const use of diagram.uses) if (!titles.has(use.docId)) titles.set(use.docId, use.docTitle);
  return [...titles.values()];
}

function UsedChip(props: { readonly docs: number }) {
  return props.docs > 0 ? (
    <span className="diagram-chip linked">
      <LinkIcon size={12} />
      In {plural(props.docs, "doc")}
    </span>
  ) : (
    <span className="diagram-chip">Not in a doc yet</span>
  );
}

/** Which diagrams a project scope shows: all, those in no project, or one project's. */
export function diagramsInScope<A extends { readonly projectId: string | null }>(
  diagrams: ReadonlyArray<A>,
  scope: ProjectScope,
  projects: ReadonlyArray<Pick<Project, "id" | "key">>,
): ReadonlyArray<A> {
  if (scope.kind === "all") return diagrams;
  if (scope.kind === "none") return diagrams.filter((diagram) => diagram.projectId === null);
  const project = projects.find((candidate) => candidate.key === scope.key);
  // A project with no id here has nothing filed in it yet.
  return project ? diagrams.filter((diagram) => diagram.projectId === project.id) : [];
}

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

/**
 * The library's Diagrams view: a grid with a "New diagram" tile, or a list.
 * The library page gives it the project scope, so a locked frame shows only
 * its project's diagrams and creates new ones there.
 */
export function DiagramsView(props: {
  readonly scope: ProjectScope;
  /** The scope's name, or null when every project shows. */
  readonly scopeLabel: string | null;
  readonly projects: ReadonlyArray<Project>;
  /** Where a new diagram is filed, in words: a project's name or "No project". */
  readonly createIn: string;
  /** The project a new diagram goes in (null: none), created first if T3 Code's is not here yet. */
  readonly resolveProjectId: () => Promise<string | null>;
}) {
  const [diagrams, setDiagrams] = useState<ReadonlyArray<DiagramListItem> | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<HomeView>(storedView);
  const [editing, setEditing] = useState<DiagramEditorTarget | null>(null);

  const reload = useCallback(async () => {
    try {
      setDiagrams(await diagramsApi.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Then with every re-read of the page: an agent or another tab may have added, changed
    // or deleted a diagram. The list carries no source, so it is its own cheap check.
    return subscribeRefresh(() => void reload());
  }, [reload]);

  const shown = useMemo(
    () => diagramsInScope(diagrams ?? [], props.scope, props.projects),
    [diagrams, props.scope, props.projects],
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

  const { resolveProjectId } = props;
  const startNew = useCallback(async () => {
    try {
      setEditing({ kind: "new", projectId: await resolveProjectId() });
    } catch {
      setFailed(true);
    }
  }, [resolveProjectId]);

  if (failed && !diagrams) {
    return (
      <>
        <p className="error">Could not load your diagrams.</p>
        <button type="button" className="button secondary" onClick={() => void reload()}>
          Try again
        </button>
      </>
    );
  }
  if (!diagrams) return null;

  const newDetail = `In ${props.createIn}, opens Draw.io`;
  return (
    <>
      <div className="home-toolbar">
        <div className="home-tabs" role="tablist" aria-label="Which diagrams">
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
          <button type="button" className="button diagram-new-button" onClick={startNew}>
            <PlusIcon size={16} />
            New diagram
          </button>
        </div>
      </div>

      {view === "grid" ? (
        <div className="doc-grid">
          <button type="button" className="doc-card doc-card-new" onClick={startNew}>
            <span className="doc-card-paper doc-card-new-paper" aria-hidden="true">
              <PlusIcon size={46} />
            </span>
            <span className="doc-card-footer">
              <span className="doc-card-icon">
                <DiagramIcon size={18} />
              </span>
              <span className="doc-card-text">
                <span className="doc-card-title">New diagram</span>
                <span className="doc-card-meta">{newDetail}</span>
              </span>
            </span>
          </button>
          {shown.map((diagram) => (
            <article key={diagram.id} className="doc-card">
              <a
                href={diagramPath(diagram.id)}
                className="doc-card-link"
                onClick={follow(diagramPath(diagram.id))}
              >
                <DiagramPicture
                  diagramId={diagram.id}
                  diagram={{ ...diagram, canEdit: true }}
                  className="diagram-card-cover"
                />
                <span className="doc-card-footer">
                  <span className="doc-card-icon">
                    <DiagramIcon size={18} />
                  </span>
                  <span className="doc-card-text">
                    <span className="doc-card-title">{diagram.title}</span>
                    <span className="doc-card-meta diagram-card-meta">
                      <UsedChip docs={linkedDocs(diagram).length} />
                      <span>{formatDay(diagram.updatedAt)}</span>
                    </span>
                  </span>
                </span>
              </a>
            </article>
          ))}
        </div>
      ) : (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Diagram</th>
              <th>Project</th>
              <th>Used in</th>
              <th>Updated</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            <tr className="doc-row doc-row-new">
              <td className="doc-row-title" colSpan={5}>
                <button type="button" onClick={startNew}>
                  <PlusIcon size={16} />
                  <span>New diagram</span>
                  <span className="doc-row-muted">{newDetail}</span>
                </button>
              </td>
            </tr>
            {shown.map((diagram) => {
              const project = diagram.projectId ? projectOf.get(diagram.projectId) : undefined;
              const docs = linkedDocs(diagram);
              return (
                <tr
                  key={diagram.id}
                  className="doc-row"
                  onClick={() => navigate(diagramPath(diagram.id))}
                >
                  <td className="doc-row-title">
                    <a href={diagramPath(diagram.id)} onClick={follow(diagramPath(diagram.id))}>
                      <DiagramPicture
                        diagramId={diagram.id}
                        diagram={{ ...diagram, canEdit: true }}
                        className="diagram-row-thumb"
                      />
                      <span className="doc-row-title-text">
                        <span>{diagram.title}</span>
                      </span>
                    </a>
                  </td>
                  <td>
                    <span className="doc-row-project">
                      {project ? <ProjectBadge name={project.name} /> : <NoProjectBadge />}
                      <span>{project?.name ?? "No project"}</span>
                    </span>
                  </td>
                  <td className={docs.length > 0 ? "diagram-row-docs" : "doc-row-muted"}>
                    {docs.length > 0 ? docs.join(", ") : "Not in a doc yet"}
                  </td>
                  <td className="doc-row-muted">{formatDay(diagram.updatedAt)}</td>
                  <td className="doc-row-actions diagram-row-actions">
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditing({ kind: "existing", diagramId: diagram.id });
                      }}
                    >
                      <PenIcon size={14} />
                      Edit
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {shown.length === 0 ? (
        <p className="home-empty">
          {props.scopeLabel
            ? `No diagrams in ${props.scopeLabel} yet.`
            : "No diagrams yet. Start one with New diagram."}
        </p>
      ) : null}

      {editing ? (
        <DiagramEditor
          target={editing}
          onClose={() => {
            setEditing(null);
            // Exit without saving changed nothing, but a reload is cheap and also picks up renames.
            void reload();
          }}
        />
      ) : null}
    </>
  );
}
