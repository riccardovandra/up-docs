import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import type { HomeProject } from "../../shared/home.ts";
import { api, ApiError } from "../api.ts";
import { formatDay } from "../home/homeLogic.ts";
import { MoreIcon, SearchIcon } from "../home/icons.tsx";
import { Menu, MenuItem, MenuSeparator } from "../home/Menu.tsx";
import { ProjectBadge } from "../home/ProjectSwitcher.tsx";
import "../home/home.css";
import {
  filterProjectRows,
  nextSort,
  projectRows,
  sortProjectRows,
  type ProjectRow,
  type ProjectSort,
  type ProjectSortKey,
} from "./projectTable.ts";

type Action = "rename" | "move" | "delete";

/** `<select>` value for "No project"; project ids are never empty. */
const NO_PROJECT = "";

const docCount = (count: number) => (count === 1 ? "1 doc" : `${count} docs`);

const COLUMNS: ReadonlyArray<{
  readonly key: ProjectSortKey;
  readonly label: string;
  readonly className: string;
}> = [
  { key: "name", label: "Name", className: "col-name" },
  { key: "docs", label: "Docs", className: "col-docs" },
  { key: "updated", label: "Updated", className: "col-updated" },
];

/** The admin's project housekeeping: a sortable table to rename, move docs out, and delete empty projects. */
export function ProjectSettings() {
  const [projects, setProjects] = useState<ReadonlyArray<HomeProject> | null>(null);
  const [open, setOpen] = useState<{ projectId: string; action: Action } | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [sort, setSort] = useState<ProjectSort>({ key: "name", direction: "asc" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkProblem, setBulkProblem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const next = (await api.library()).projects;
    setProjects(next);
    // Keep only selections that are still empty projects.
    const empty = new Set(next.filter((p) => p.docs.length === 0).map((p) => p.id));
    setSelected((current) => new Set([...current].filter((id) => empty.has(id))));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const allRows = useMemo(() => projectRows(projects ?? []), [projects]);
  const rows = useMemo(
    () => sortProjectRows(filterProjectRows(allRows, { query, hideEmpty }), sort),
    [allRows, query, hideEmpty, sort],
  );
  const emptyCount = allRows.filter((row) => row.docCount === 0).length;
  const visibleEmpty = rows.filter((row) => row.docCount === 0);
  const allVisibleEmptySelected =
    visibleEmpty.length > 0 && visibleEmpty.every((row) => selected.has(row.project.id));

  const start = (project: HomeProject, action: Action) => {
    setOpen({ projectId: project.id, action });
    setName(project.name);
    setTarget(null);
    setProblem(null);
  };

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      setOpen(null);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError && cause.body.error === "project_not_empty"
          ? "A doc was added to this project meanwhile. Move its docs again, then delete."
          : `That did not work: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllVisibleEmpty = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visibleEmpty) {
        if (allVisibleEmptySelected) next.delete(row.project.id);
        else next.add(row.project.id);
      }
      return next;
    });

  const deleteSelected = async () => {
    const doomed = allRows.filter((row) => selected.has(row.project.id));
    if (doomed.length === 0) return;
    const list = doomed.map((row) => row.project.name).join(", ");
    const what =
      doomed.length === 1
        ? `Delete the empty project "${list}"?`
        : `Delete ${doomed.length} empty projects?\n\n${list}`;
    if (!window.confirm(what)) return;
    setBusy(true);
    setBulkProblem(null);
    const failed: Array<string> = [];
    for (const row of doomed) {
      try {
        await api.deleteProject(row.project.id);
      } catch {
        failed.push(row.project.name);
      }
    }
    if (failed.length > 0) {
      setBulkProblem(
        `Could not delete ${failed.join(", ")}. A doc may have been added meanwhile; reload and check.`,
      );
    }
    setBusy(false);
    await reload();
  };

  if (!projects) return <p className="muted">Loading projects…</p>;
  if (projects.length === 0) return <p className="muted">No projects yet.</p>;

  return (
    <div className="project-table-wrap">
      <div className="project-toolbar">
        <label className="project-search">
          <SearchIcon size={15} />
          <input
            type="search"
            aria-label="Filter projects"
            placeholder="Filter projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="project-check">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(event) => setHideEmpty(event.target.checked)}
          />
          Hide empty ({emptyCount})
        </label>
        {selected.size > 0 ? (
          <button
            type="button"
            className="button danger"
            disabled={busy}
            onClick={() => void deleteSelected()}
          >
            Delete {selected.size} empty
          </button>
        ) : null}
      </div>
      {bulkProblem ? <p className="error">{bulkProblem}</p> : null}

      <table className="project-table">
        <thead>
          <tr>
            <th className="col-select">
              <input
                type="checkbox"
                aria-label="Select every empty project shown"
                title="Select every empty project shown"
                disabled={visibleEmpty.length === 0}
                checked={allVisibleEmptySelected}
                onChange={toggleAllVisibleEmpty}
              />
            </th>
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              return (
                <th
                  key={column.key}
                  className={column.className}
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    className="project-sort"
                    onClick={() => setSort((current) => nextSort(current, column.key))}
                  >
                    {column.label}
                    <span aria-hidden="true" className="project-sort-arrow">
                      {active ? (sort.direction === "asc" ? "↑" : "↓") : ""}
                    </span>
                  </button>
                </th>
              );
            })}
            <th className="col-source">Source</th>
            <th className="col-actions" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted project-none">
                No projects match.
              </td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <ProjectTableRow
              key={row.project.id}
              row={row}
              others={projects.filter((other) => other.id !== row.project.id)}
              action={open?.projectId === row.project.id ? open.action : null}
              selected={selected.has(row.project.id)}
              onToggle={() => toggle(row.project.id)}
              onStart={(action) => start(row.project, action)}
              onCancel={() => setOpen(null)}
              name={name}
              setName={setName}
              target={target}
              setTarget={setTarget}
              busy={busy}
              problem={problem}
              run={run}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectTableRow(props: {
  readonly row: ProjectRow;
  readonly others: ReadonlyArray<HomeProject>;
  readonly action: Action | null;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onStart: (action: Action) => void;
  readonly onCancel: () => void;
  readonly name: string;
  readonly setName: (name: string) => void;
  readonly target: string | null;
  readonly setTarget: (target: string) => void;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const { row, others, action, name, target, busy } = props;
  const { project, docCount: count, source } = row;
  const empty = count === 0;
  const destination =
    target === NO_PROJECT ? "No project" : (others.find((other) => other.id === target)?.name ?? null);
  const moveDocs = () => api.moveProjectDocs(project.id, target || null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (action === "rename" && name.trim() && name.trim() !== project.name) {
      void props.run(() => api.renameProject(project.id, name.trim()));
    } else if (action === "move" && target !== null) {
      void props.run(moveDocs);
    } else if (action === "delete" && (empty || target !== null)) {
      const what = empty
        ? `Delete the project "${project.name}"?`
        : `Move ${docCount(count)} to "${destination}", then delete "${project.name}"?`;
      if (!window.confirm(what)) return;
      void props.run(async () => {
        if (!empty) await moveDocs();
        await api.deleteProject(project.id);
      });
    }
  };

  const picker = (
    <select
      aria-label="Destination"
      value={target ?? "choose"}
      onChange={(event) => props.setTarget(event.target.value)}
    >
      <option value="choose" disabled>
        Choose a destination
      </option>
      {others.map((other) => (
        <option key={other.id} value={other.id}>
          {other.name}
        </option>
      ))}
      <option value={NO_PROJECT}>No project</option>
    </select>
  );

  return (
    <>
      <tr className={empty ? "is-empty" : undefined}>
        <td className="col-select">
          <input
            type="checkbox"
            aria-label={`Select ${project.name}`}
            title={empty ? undefined : "Only empty projects can be deleted in bulk"}
            disabled={!empty}
            checked={props.selected}
            onChange={props.onToggle}
          />
        </td>
        <td className="col-name">
          <span className="project-name-cell">
            <ProjectBadge name={project.name} />
            <span className="project-name">{project.name}</span>
          </span>
        </td>
        <td className="col-docs">{count}</td>
        <td className="col-updated muted">
          {row.updatedAt === null ? "–" : formatDay(row.updatedAt)}
        </td>
        <td className="col-source muted" title={project.key}>
          {source.kind === "github" ? <code>{source.label}</code> : source.label}
        </td>
        <td className="col-actions">
          <Menu label={`Actions for ${project.name}`} trigger={<MoreIcon size={16} />}>
            {(close) => (
              <>
                <MenuItem
                  onSelect={() => {
                    close();
                    props.onStart("rename");
                  }}
                >
                  Rename
                </MenuItem>
                {!empty ? (
                  <MenuItem
                    onSelect={() => {
                      close();
                      props.onStart("move");
                    }}
                  >
                    Move docs
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={() => {
                    close();
                    props.onStart("delete");
                  }}
                >
                  Delete
                </MenuItem>
              </>
            )}
          </Menu>
        </td>
      </tr>
      {action ? (
        <tr className="project-action-row">
          <td colSpan={6}>
            <form onSubmit={submit} className="inline-form project-action">
              {action === "rename" ? (
                <input
                  aria-label="Project name"
                  maxLength={200}
                  value={name}
                  onChange={(event) => props.setName(event.target.value)}
                  autoFocus
                />
              ) : null}
              {action === "move" ? (
                <>
                  <span>Move {docCount(count)} to</span>
                  {picker}
                </>
              ) : null}
              {action === "delete" && !empty ? (
                <>
                  <span>Holds {docCount(count)}. Move them to</span>
                  {picker}
                </>
              ) : null}
              {action === "delete" && empty ? <span>The project is empty.</span> : null}
              <button
                type="submit"
                className={action === "delete" ? "button danger" : "button"}
                disabled={
                  busy ||
                  (action === "rename" && (!name.trim() || name.trim() === project.name)) ||
                  (action !== "rename" && !empty && target === null)
                }
              >
                {action === "rename"
                  ? "Save"
                  : action === "move"
                    ? "Move"
                    : empty
                      ? "Delete project"
                      : "Move and delete"}
              </button>
              <button type="button" className="link-button" onClick={props.onCancel}>
                Cancel
              </button>
            </form>
            {props.problem ? <p className="error">{props.problem}</p> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
