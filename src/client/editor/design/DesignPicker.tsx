import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DesignListItem } from "../../../shared/design.ts";
import type { Project } from "../../../shared/protocol.ts";
import { api } from "../../api.ts";
import { DesignPicture } from "../../designs/DesignsView.tsx";
import { designsApi } from "../../designs/designsApi.ts";
import { CloseIcon } from "../../home/icons.tsx";
import { NoProjectBadge, ProjectBadge } from "../../home/ProjectSwitcher.tsx";
import { pickerLists, type PickerScope } from "../drawio/blockLogic.ts";
import "../../home/home.css";
import "../drawio/drawio.css";
import "./design.css";

/**
 * "Insert a design" (S4): the designs of the doc's project first, every
 * project one click away (unless the frame is locked to its project). It
 * lists the designs the person is on, which are the ones the library shows.
 * New designs are made in Designs, where the editor opens.
 */
export function DesignPicker(props: {
  /** The doc's project; null for a doc in no project. */
  readonly projectId: string | null;
  /** True inside a parent that keeps this frame in one project. */
  readonly locked: boolean;
  readonly onPick: (design: DesignListItem) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [designs, setDesigns] = useState<ReadonlyArray<DesignListItem> | null>(null);
  const [failed, setFailed] = useState(false);
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([]);
  const [scope, setScope] = useState<PickerScope>("project");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setDesigns(await designsApi.list());
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
    () => pickerLists(designs ?? [], { projectId: props.projectId, scope, locked: props.locked }),
    [designs, props.projectId, props.locked, scope],
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
      className="drawio-picker design-picker"
      aria-label="Insert a design"
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="drawio-picker-head">
        <h2>Insert a design</h2>
        <button
          type="button"
          className="home-icon-button"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          <CloseIcon />
        </button>
      </div>
      <p className="muted">The doc shows the design you pick, so later saves show up here.</p>

      {canSeeAll ? (
        <div className="home-tabs drawio-picker-tabs" role="tablist" aria-label="Which designs">
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
              {designs ? <span className="diagram-count">{count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="drawio-picker-grid">
        {lists.shown.map((design) => (
          <button
            key={design.id}
            type="button"
            className="drawio-pick"
            onClick={() => props.onPick(design)}
          >
            <DesignPicture design={design} className="drawio-pick-preview design-pick-preview" />
            <span className="drawio-pick-text">
              {design.title}
              <span>
                {scope === "all" && canSeeAll ? nameOf(design.projectId) : "Design"}
              </span>
            </span>
          </button>
        ))}
      </div>

      {failed ? (
        <p className="error drawio-picker-note">
          Could not load your designs.{" "}
          <button type="button" className="link-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : designs === null ? (
        <p className="muted drawio-picker-note" role="status">
          Loading your designs…
        </p>
      ) : lists.shown.length === 0 ? (
        <p className="muted drawio-picker-note">
          {scope === "all" && canSeeAll
            ? "You have no designs yet. Make one in Designs."
            : `No designs ${props.projectId === null ? "outside a project" : `in ${home}`} yet. ` +
              (canSeeAll ? "Look in All projects, or make one in Designs." : "Make one in Designs.")}
        </p>
      ) : null}
    </dialog>
  );
}
