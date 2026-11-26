import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import {
  DESIGNER_MESSAGE,
  DESIGNER_PROTOCOL,
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
import { navigate, parseRoute } from "../router.ts";
import { getAgentSocketURL } from "./agentBridge.ts";
import { DesignIcon } from "./DesignIcon.tsx";
import { DesignSaver, type SaveStatus } from "./designSaver.ts";
import { designErrorText, DesignSaveError, designsApi } from "./designsApi.ts";
import { DesignPicture } from "./DesignsView.tsx";
import "../home/home.css";
import "./designs.css";

/** How long the editor may take to say it is ready before the page says it did not start. */
const EDITOR_START_MS = 30_000;
/** How long leaving waits for the editor to save what is unsaved (it can take 20 s or more). */
const FLUSH_WAIT_MS = 30_000;

/** The editor's answer to `flush`, or null when it did not answer in time. */
type FlushResult = { readonly saved: boolean; readonly unsaved: boolean } | null;

const PICTURE_NOTES = {
  too_large: "Saved. The picture was too large to keep, so cards show the previous one.",
  invalid: "Saved. The editor sent no usable picture, so cards show the previous one.",
} as const;

function StatusLine(props: {
  readonly status: SaveStatus;
  readonly design: DesignView;
  readonly leaving: boolean;
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
  const text = props.leaving
    ? "Saving before leaving…"
    : status.kind === "saving"
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
  /** Asks the editor to save what is unsaved; null while no editor is open. */
  const flushEditor = useRef<(() => Promise<FlushResult>) | null>(null);
  const [leaving, setLeaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    let opened = false;
    // `flushed` carries no id, so only one flush is ever in flight: its answer is the next
    // `flushed`. A request while one runs waits for it, then sends its own, so a leave
    // never takes the answer to an earlier (visibility) flush. An answer with none in
    // flight (one that timed out) is dropped.
    let inFlight: { readonly answer: (result: FlushResult) => void } | null = null;
    let flushChain: Promise<FlushResult> = Promise.resolve(null);
    const flushOnce = () =>
      new Promise<FlushResult>((resolve) => {
        if (!live) return resolve(null);
        const timer = window.setTimeout(() => {
          inFlight = null;
          resolve(null);
        }, FLUSH_WAIT_MS);
        inFlight = {
          answer: (result) => {
            window.clearTimeout(timer);
            inFlight = null;
            resolve(result);
          },
        };
        post({ type: DESIGNER_MESSAGE.flush });
      });
    const sendFlush = () => {
      flushChain = flushChain.then(flushOnce, flushOnce);
      return flushChain;
    };
    flushEditor.current = () =>
      opened ? sendFlush() : Promise.resolve({ saved: false, unsaved: false });
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
          if (message.protocol !== DESIGNER_PROTOCOL) {
            setEditorError(
              `This editor build (${message.version ?? "unknown version"}) does not match this UP Docs. Update UP Docs or its pinned editor.`,
            );
            break;
          }
          setEditorError(null);
          void sendLoad();
          break;
        case DESIGNER_MESSAGE.loaded:
          opened = true;
          setEditorReady(true);
          break;
        case DESIGNER_MESSAGE.save:
          queue.offer({ seq: message.seq, fig: message.fig, png: message.png });
          break;
        case DESIGNER_MESSAGE.flushed:
          inFlight?.answer({ saved: message.saved, unsaved: message.unsaved });
          break;
        case DESIGNER_MESSAGE.error:
          // A save this page refused already shows as "Save failed" in the header.
          if (message.reason === "save-failed" && queue.status.kind === "failed") break;
          setEditorError(message.message);
          break;
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (queue.unsaved) event.preventDefault();
    };
    // A tab being hidden may be closed next: save what is unsaved now (no answer awaited).
    const onHidden = () => {
      // Already flushing: that one covers it.
      if (document.visibilityState === "hidden" && opened && !inFlight) void sendFlush();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      live = false;
      window.clearTimeout(started);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", onHidden);
      inFlight?.answer(null);
      saver.current = null;
      flushEditor.current = null;
    };
  }, [showEditor, editorOrigin, designId]);

  /** Saves what the editor has not saved yet, then leaves; asks first if something stays unsaved. */
  const leaveTo = async (path: string) => {
    if (leaving) return;
    setLeaving(true);
    const result = flushEditor.current
      ? await flushEditor.current()
      : { saved: false, unsaved: false };
    // Gone meanwhile (Back, or another link): this page no longer decides anything.
    const here = parseRoute(window.location.pathname);
    if (!mounted.current || here.name !== "design" || here.designId !== designId) return;
    setLeaving(false);
    const unsaved = result === null || result.unsaved || saver.current?.unsaved === true;
    if (unsaved && !window.confirm("A change is not saved yet. Leave the design anyway?")) return;
    navigate(path);
  };

  /** Every in-app link in the header (UP Docs, Designs) leaves through `leaveTo`. */
  const onHeaderClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const link = (event.target as Element).closest("a[href]");
    const href = link?.getAttribute("href");
    if (!href?.startsWith("/")) return;
    event.preventDefault();
    event.stopPropagation();
    void leaveTo(href);
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
      <header className="doc-header design-page-header" onClickCapture={onHeaderClick}>
        <div className="doc-header-title">
          <HomeLink />
          <span className="doc-header-crumb">/</span>
          <a href={DESIGNS_PATH} className="home-link design-crumb">
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
            {design.projectId === null ? (
              <NoProjectBadge />
            ) : (
              <ProjectBadge name={project?.name ?? "?"} />
            )}
            {design.projectId === null ? "No project" : (project?.name ?? "")}
          </span>
        </div>
        <div className="doc-header-actions">
          {showEditor ? (
            <StatusLine
              leaving={leaving}
              status={status}
              design={design}
              onRetry={() => {
                // A fresh save from the editor, with a new number it waits on; after a
                // conflict, made on top of the newer version.
                saver.current?.prepareRetry();
                frame.current?.contentWindow?.postMessage(
                  { type: DESIGNER_MESSAGE.saveNow },
                  editorOrigin ?? "",
                );
              }}
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
