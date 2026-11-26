import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import {
  DESIGNER_MESSAGE,
  DESIGNS_PATH,
  designerFrameUrl,
  parseDesignerMessage,
  type DesignView,
} from "../../shared/design.ts";
import type { Project } from "../../shared/protocol.ts";
import { api, ApiError } from "../api.ts";
import { useDiagramChanges } from "../diagrams/drawioEditing.ts";
import { HomeLink } from "../home/HomeLink.tsx";
import { NoProjectBadge, ProjectBadge } from "../home/ProjectSwitcher.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { useLockedProject } from "../lockedProject.ts";
import { navigate } from "../router.ts";
import { getAgentSocketURL } from "./agentBridge.ts";
import { DesignIcon } from "./DesignIcon.tsx";
import { DesignSaver, type SaveStatus } from "./designSaver.ts";
import { designErrorText, DesignSaveError, designsApi } from "./designsApi.ts";
import { DesignPicture } from "./DesignsView.tsx";
import "../home/home.css";
import "./designs.css";

/** How long the editor may take to say it is ready before the page says it did not start. */
const EDITOR_START_MS = 30_000;

const PICTURE_NOTES = {
  too_large: "Saved. The picture was too large to keep, so cards show the previous one.",
  invalid: "Saved. The editor sent no usable picture, so cards show the previous one.",
} as const;

function StatusLine(props: {
  readonly status: SaveStatus;
  readonly design: DesignView;
  readonly onRetry: () => void;
}) {
  const { status } = props;
  if (status.kind === "failed") {
    return (
      <span className="design-status" data-kind="failed" role="status" title={status.message}>
        Save failed
        <button type="button" className="button secondary small" onClick={props.onRetry}>
          {status.conflict ? "Save over it" : "Retry"}
        </button>
      </span>
    );
  }
  const text =
    status.kind === "saving"
      ? "Saving…"
      : status.kind === "saved" || props.design.version > 0
        ? "Saved"
        : "Not saved yet";
  return (
    <span className="design-status" data-kind={status.kind} role="status">
      {text}
    </span>
  );
}

/**
 * One design's own page, `/designs/:id`: an UP Docs header (back to Designs,
 * the title, its project, save status) above the editor, which runs in a
 * frame on its own origin and talks to this page only by postMessage. On a
 * touch-only device the page shows the picture instead of the editor.
 */
export function DesignPage(props: { readonly designId: string }) {
  const { designId } = props;
  const lock = useLockedProject();
  const changesHere = useDiagramChanges();
  const [design, setDesign] = useState<DesignView | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([]);
  const [renaming, setRenaming] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const saver = useRef<DesignSaver | null>(null);
  const title = useRef("");
  title.current = design?.title ?? "";

  const load = useCallback(async () => {
    try {
      setDesign(await designsApi.get(designId));
      setFailed(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setFailed(true);
    }
  }, [designId]);

  useEffect(() => {
    void load();
    // The project's name, for the header; the page works without it.
    api.library().then(
      (library) => setProjects(library.projects),
      () => undefined,
    );
  }, [load]);

  const loaded = design !== null;
  const canEdit = design?.canEdit === true;
  const editorOrigin = design ? (design.editor.origin ?? window.location.origin) : null;
  const showEditor = loaded && canEdit && changesHere;

  // The editor frame: load the file when it is ready, store each save it sends.
  useEffect(() => {
    if (!showEditor || editorOrigin === null) return;
    const post = (message: Record<string, unknown>, transfer: Array<Transferable> = []) =>
      frame.current?.contentWindow?.postMessage(message, editorOrigin, transfer);
    const queue = new DesignSaver(0, {
      send: async (baseVersion, save) => {
        try {
          const result = await designsApi.save(designId, {
            baseVersion,
            fig: save.fig,
            png: save.png,
          });
          setDesign(result.design);
          return {
            ok: true,
            version: result.design.version,
            ...(result.pictureSkipped ? { note: PICTURE_NOTES[result.pictureSkipped] } : {}),
          };
        } catch (cause) {
          const current =
            cause instanceof DesignSaveError && cause.body.error === "version_conflict"
              ? cause.body.design?.version
              : undefined;
          return {
            ok: false,
            message: designErrorText(cause),
            ...(current === undefined ? {} : { currentVersion: current }),
          };
        }
      },
      ack: (seq) => post({ type: DESIGNER_MESSAGE.saved, seq }),
      onStatus: setStatus,
      onSaved: (_version, note) => {
        if (note) setNotice(note);
      },
      now: () => Date.now(),
    });
    saver.current = queue;
    let live = true;
    const started = window.setTimeout(() => {
      if (live) setEditorError("The editor did not start. Reload the page to try again.");
    }, EDITOR_START_MS);

    const sendLoad = async () => {
      try {
        const file = await designsApi.fig(designId);
        const socketURL = await getAgentSocketURL(designId);
        if (!live) return;
        queue.rebase(file?.version ?? 0);
        const bytes = file?.bytes ?? null;
        post(
          {
            type: DESIGNER_MESSAGE.load,
            bytes,
            name: title.current,
            ...(socketURL ? { socketURL } : {}),
          },
          bytes ? [bytes] : [],
        );
      } catch (cause) {
        if (live) setEditorError(`Could not open the design: ${designErrorText(cause)}`);
      }
    };

    const onMessage = (event: MessageEvent) => {
      // Only the editor frame, from the editor's origin.
      if (event.source !== frame.current?.contentWindow || event.origin !== editorOrigin) return;
      const message = parseDesignerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case DESIGNER_MESSAGE.ready:
          window.clearTimeout(started);
          setEditorError(null);
          void sendLoad();
          break;
        case DESIGNER_MESSAGE.loaded:
          setEditorReady(true);
          break;
        case DESIGNER_MESSAGE.save:
          queue.offer({ seq: message.seq, fig: message.fig, png: message.png });
          break;
        case DESIGNER_MESSAGE.error:
          setEditorError(message.message);
          break;
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (queue.unsaved) event.preventDefault();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      live = false;
      window.clearTimeout(started);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("beforeunload", beforeUnload);
      saver.current = null;
    };
  }, [showEditor, editorOrigin, designId]);

  const leave = (path: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    if (
      saver.current?.unsaved &&
      !window.confirm("A change is not saved yet. Leave the design anyway?")
    ) {
      return;
    }
    navigate(path);
  };

  const back = (label: string) => (
    <button type="button" className="button secondary" onClick={() => navigate(DESIGNS_PATH)}>
      {label}
    </button>
  );

  if (missing) {
    return (
      <main className="home">
        <p className="home-empty">This design does not exist, or it is not shared with you.</p>
        {back("Back to Designs")}
      </main>
    );
  }
  if (failed && !design) {
    return (
      <main className="home">
        <p className="error">Could not load this design.</p>
        {back("Back to Designs")}
      </main>
    );
  }
  if (!design || lock.kind === "loading") return null;
  if (lock.kind === "locked" && (lock.projectId === null || design.projectId !== lock.projectId)) {
    return (
      <main className="home">
        <p className="home-empty">This design is not part of {lock.name}.</p>
        {back(`Back to ${lock.name}`)}
      </main>
    );
  }

  const project = projects.find((candidate) => candidate.id === design.projectId);
  const remove = async () => {
    if (!window.confirm(`Delete "${design.title}" and all its versions for everyone?`)) return;
    try {
      await designsApi.remove(designId);
      navigate(DESIGNS_PATH, { replace: true });
    } catch (cause) {
      setNotice(designErrorText(cause));
    }
  };

  return (
    <div className="design-page">
      <header className="doc-header design-page-header">
        <div className="doc-header-title">
          <HomeLink />
          <span className="doc-header-crumb">/</span>
          <a href={DESIGNS_PATH} className="home-link design-crumb" onClick={leave(DESIGNS_PATH)}>
            <DesignIcon size={16} />
            Designs
          </a>
          <span className="doc-header-crumb">/</span>
          {canEdit && changesHere ? (
            <button
              type="button"
              className="design-title"
              title="Rename"
              onClick={() => setRenaming(true)}
            >
              {design.title}
            </button>
          ) : (
            <span className="design-title">{design.title}</span>
          )}
          <span className="design-project">
            {design.projectId === null ? <NoProjectBadge /> : <ProjectBadge name={project?.name ?? "?"} />}
            {design.projectId === null ? "No project" : (project?.name ?? "")}
          </span>
        </div>
        <div className="doc-header-actions">
          {showEditor ? (
            <StatusLine
              status={status}
              design={design}
              onRetry={() => saver.current?.retry()}
            />
          ) : null}
          {design.role === "owner" && changesHere ? (
            <button type="button" className="button secondary small" onClick={() => void remove()}>
              Delete
            </button>
          ) : null}
        </div>
      </header>

      {status.kind === "failed" ? (
        <div className="notice design-notice" role="alert">
          Save failed: {status.message}{" "}
          {status.conflict
            ? "Save over it to keep the version open here, or reload to get the newer one."
            : "Your changes are still in the editor; retry to store them."}
        </div>
      ) : null}
      {editorError ? (
        <div className="notice design-notice" role="alert">
          {editorError}
          <button type="button" className="link-button" onClick={() => setEditorError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="notice design-notice" role="status">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {showEditor && editorOrigin !== null ? (
        <>
          {editorReady ? null : <p className="design-loading">Opening the editor…</p>}
          <iframe
            ref={frame}
            className="design-frame"
            title={`${design.title} editor`}
            src={designerFrameUrl(editorOrigin, window.location.origin)}
            allow="clipboard-read; clipboard-write; fullscreen"
            referrerPolicy="no-referrer"
          />
        </>
      ) : (
        <>
          <div className="design-view-only">
            <DesignPicture design={design} className="design-view-only-picture" />
          </div>
          <p className="design-view-only-note">
            {canEdit
              ? "Open this design on a computer to edit it."
              : "You can view this design but not change it."}
          </p>
        </>
      )}

      {renaming ? (
        <TitleDialog
          heading="Rename design"
          detail={null}
          initial={design.title}
          submitLabel="Rename"
          onSubmit={async (next) => {
            if (next !== design.title) setDesign(await designsApi.rename(designId, next));
          }}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}
