import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DiagramListItem } from "../../../shared/drawio.ts";
import type { Project } from "../../../shared/protocol.ts";
import { api } from "../../api.ts";
import { DiagramPicture } from "../../diagrams/DiagramPicture.tsx";
import { diagramsApi } from "../../diagrams/diagramsApi.ts";
import { CloseIcon, PlusIcon } from "../../home/icons.tsx";
import { NoProjectBadge, ProjectBadge } from "../../home/ProjectSwitcher.tsx";
import { pickerLists, type PickerScope } from "./blockLogic.ts";
import "../../home/home.css";
import "./drawio.css";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const linkedDocs = (diagram: DiagramListItem) => new Set(diagram.uses.map((use) => use.docId)).size;

/**
 * "Insert a diagram": the diagrams of the doc's project first, every project
 * one click away (unless the frame is locked to its project), and "New
 * diagram" always on offer. It lists the diagrams the person manages, which
 * are the ones the library shows them.
 */
export function DiagramPicker(props: {
  /** The doc's project; null for a doc in no project. */
  readonly projectId: string | null;
  /** True inside a parent that keeps this frame in one project. */
  readonly locked: boolean;
  readonly onPick: (diagram: DiagramListItem) => void;
  readonly onNew: () => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [diagrams, setDiagrams] = useState<ReadonlyArray<DiagramListItem> | null>(null);
  const [failed, setFailed] = useState(false);
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([]);
  const [scope, setScope] = useState<PickerScope>("project");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setDiagrams(await diagramsApi.list());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // Project names, for the labels; the picker works without them.
    api.library().then(
      (library) => setProjects(library.projects),
      () => undefined,
    );
  }, [load]);

  const lists = useMemo(
    () => pickerLists(diagrams ?? [], { projectId: props.projectId, scope, locked: props.locked }),
    [diagrams, props.projectId, props.locked, scope],
  );
  const nameOf = (projectId: string | null) =>
    projectId === null
      ? "No project"
      : (projects.find((project) => project.id === projectId)?.name ?? "This project");
  const home = nameOf(props.projectId);
  const canSeeAll = lists.scopes.length > 1;

  return (
    <dialog
      ref={dialog}
      className="drawio-picker"
      aria-label="Insert a diagram"
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="drawio-picker-head">
        <h2>Insert a diagram</h2>
        <button
          type="button"
          className="home-icon-button"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          <CloseIcon />
        </button>
      </div>
      <p className="muted">The doc links to the diagram you pick, so later edits show up here.</p>

      {canSeeAll ? (
        <div className="home-tabs drawio-picker-tabs" role="tablist" aria-label="Which diagrams">
          {lists.scopes.map(({ scope: each, count }) => (
            <button
              key={each}
              type="button"
              role="tab"
              className="home-tab"
              aria-selected={scope === each}
              onClick={() => setScope(each)}
            >
              {each === "all" ? (
                "All projects"
              ) : (
                <span className="drawio-picker-project">
                  {props.projectId === null ? <NoProjectBadge /> : <ProjectBadge name={home} />}
                  {home}
                </span>
              )}
              {diagrams ? <span className="diagram-count">{count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="drawio-picker-grid">
        <button type="button" className="drawio-pick" onClick={props.onNew}>
          <span className="drawio-pick-preview drawio-pick-new" aria-hidden="true">
            <PlusIcon size={34} />
          </span>
          <span className="drawio-pick-text">
            New diagram
            <span>{props.projectId === null ? "In no project" : `In ${home}`}, opens Draw.io</span>
          </span>
        </button>
        {lists.shown.map((diagram) => (
          <button
            key={diagram.id}
            type="button"
            className="drawio-pick"
            onClick={() => props.onPick(diagram)}
          >
            <DiagramPicture
              diagramId={diagram.id}
              diagram={{ ...diagram, canEdit: true }}
              className="drawio-pick-preview"
            />
            <span className="drawio-pick-text">
              {diagram.title}
              <span>
                {scope === "all" && canSeeAll ? `${nameOf(diagram.projectId)}, ` : ""}
                in {plural(linkedDocs(diagram), "doc")}
              </span>
            </span>
          </button>
        ))}
      </div>

      {failed ? (
        <p className="error drawio-picker-note">
          Could not load your diagrams.{" "}
          <button type="button" className="link-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : diagrams === null ? (
        <p className="muted drawio-picker-note" role="status">
          Loading your diagrams…
        </p>
      ) : lists.shown.length === 0 ? (
        <p className="muted drawio-picker-note">
          {scope === "all" && canSeeAll
            ? "You have no diagrams yet. Draw a new one."
            : `No diagrams ${props.projectId === null ? "outside a project" : `in ${home}`} yet. ` +
              (canSeeAll ? "Draw a new one, or look in All projects." : "Draw a new one.")}
        </p>
      ) : null}
    </dialog>
  );
}
