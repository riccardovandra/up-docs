import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { HomeProject } from "../../shared/home.ts";
import { api, ApiError } from "../api.ts";

type Action = "rename" | "move" | "delete";

/** `<select>` value for "No project"; project ids are never empty. */
const NO_PROJECT = "";

const docCount = (count: number) => (count === 1 ? "1 doc" : `${count} docs`);

/** The admin's project housekeeping: rename, move every doc out, delete once empty. */
export function ProjectSettings() {
  const [projects, setProjects] = useState<ReadonlyArray<HomeProject> | null>(null);
  const [open, setOpen] = useState<{ projectId: string; action: Action } | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setProjects((await api.library()).projects);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  if (!projects) return <p className="muted">Loading projects…</p>;
  if (projects.length === 0) return <p className="muted">No projects yet.</p>;

  return (
    <ul className="project-list">
      {projects.map((project) => {
        const action = open?.projectId === project.id ? open.action : null;
        const count = project.docs.length;
        const others = projects.filter((other) => other.id !== project.id);
        const destination =
          target === NO_PROJECT
            ? "No project"
            : (others.find((other) => other.id === target)?.name ?? null);
        const moveDocs = () => api.moveProjectDocs(project.id, target || null);

        const submit = (event: FormEvent) => {
          event.preventDefault();
          if (action === "rename" && name.trim() && name.trim() !== project.name) {
            void run(() => api.renameProject(project.id, name.trim()));
          } else if (action === "move" && target !== null) {
            void run(moveDocs);
          } else if (action === "delete" && (count === 0 || target !== null)) {
            const what =
              count === 0
                ? `Delete the project "${project.name}"?`
                : `Move ${docCount(count)} to "${destination}", then delete "${project.name}"?`;
            if (!window.confirm(what)) return;
            void run(async () => {
              if (count > 0) await moveDocs();
              await api.deleteProject(project.id);
            });
          }
        };

        const picker = (
          <select
            aria-label="Destination"
            value={target ?? "choose"}
            onChange={(event) => setTarget(event.target.value)}
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
          <li key={project.id}>
            <div className="project-row">
              <span className="project-name">{project.name}</span>
              <span className="muted">
                {docCount(count)} · <code>{project.key}</code>
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => start(project, "rename")}
              >
                Rename
              </button>
              {count > 0 ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => start(project, "move")}
                >
                  Move docs
                </button>
              ) : null}
              <button
                type="button"
                className="link-button danger"
                onClick={() => start(project, "delete")}
              >
                Delete
              </button>
            </div>
            {action ? (
              <form onSubmit={submit} className="inline-form project-action">
                {action === "rename" ? (
                  <input
                    aria-label="Project name"
                    maxLength={200}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoFocus
                  />
                ) : null}
                {action === "move" ? (
                  <>
                    <span>Move {docCount(count)} to</span>
                    {picker}
                  </>
                ) : null}
                {action === "delete" && count > 0 ? (
                  <>
                    <span>Holds {docCount(count)}. Move them to</span>
                    {picker}
                  </>
                ) : null}
                {action === "delete" && count === 0 ? <span>The project is empty.</span> : null}
                <button
                  type="submit"
                  className={action === "delete" ? "button danger" : "button"}
                  disabled={
                    busy ||
                    (action === "rename" && (!name.trim() || name.trim() === project.name)) ||
                    (action !== "rename" && count > 0 && target === null)
                  }
                >
                  {action === "rename"
                    ? "Save"
                    : action === "move"
                      ? "Move"
                      : count > 0
                        ? "Move and delete"
                        : "Delete project"}
                </button>
                <button type="button" className="link-button" onClick={() => setOpen(null)}>
                  Cancel
                </button>
              </form>
            ) : null}
            {action && problem ? <p className="error">{problem}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
