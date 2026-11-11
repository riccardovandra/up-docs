import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { DEFAULT_DIAGRAM_TITLE, type DiagramSummary } from "../../shared/drawio.ts";
import { LinkIcon } from "../home/icons.tsx";
import { refreshDiagrams } from "./diagramRefresh.ts";
import { diagramsApi } from "./diagramsApi.ts";
import { drawioEditorUrl, mountDrawioFrame } from "./drawioFrame.ts";
import {
  startEditorSession,
  type DiagramEditorTarget,
  type EditorSession,
  type EditorSessionState,
} from "./editorSession.ts";
import "./diagrams.css";

export type { DiagramEditorTarget } from "./editorSession.ts";

/** Whether the app shows its dark palette: the saved or embedded appearance, else the system's. */
function appIsDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark" || theme === "light") return theme === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The real Draw.io editor in a full-window overlay, over whatever page the
 * person was on. Save & Exit stores the diagram and its picture, then calls
 * `onClose` with the saved diagram; Exit calls it with whatever was saved
 * before (null when nothing was). A `new` target is created by its first save.
 *
 * The target is read once, when the overlay mounts: give the component a `key`
 * to edit another diagram.
 */
export function DiagramEditor(props: {
  readonly target: DiagramEditorTarget;
  /** After every save that reached the server, before any exit. */
  readonly onSaved?: (diagram: DiagramSummary) => void;
  readonly onClose: (saved: DiagramSummary | null) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const session = useRef<EditorSession | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [target] = useState(props.target);
  const [state, setState] = useState<EditorSessionState>({
    phase: "opening",
    title: target.kind === "new" ? (target.title ?? DEFAULT_DIAGRAM_TITLE) : "",
    message: null,
  });
  /** How many docs link the diagram, once known. */
  const [linked, setLinked] = useState<number | null>(target.kind === "new" ? 0 : null);

  useEffect(() => {
    const parent = stage.current;
    if (!parent) return;
    const frame = mountDrawioFrame({
      url: drawioEditorUrl({ dark: appIsDark() }),
      parent,
      title: "Draw.io editor",
    });
    const started = startEditorSession({
      frame,
      api: diagramsApi,
      target,
      onState: setState,
      onSaved: (diagram) => callbacks.current.onSaved?.(diagram),
      onClose: (saved) => callbacks.current.onClose(saved),
    });
    session.current = started;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      started.dispose();
      frame.remove();
      session.current = null;
      document.body.style.overflow = overflow;
      // However the overlay closed, the page under it shows what the server now has.
      void refreshDiagrams();
    };
  }, [target]);

  useEffect(() => {
    if (target.kind !== "existing") return;
    let live = true;
    diagramsApi.uses(target.diagramId).then(
      ({ uses, otherDocs }) => {
        if (live) setLinked(new Set(uses.map((use) => use.docId)).size + otherDocs);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [target]);

  const starting = state.phase === "opening" || state.phase === "failed";
  return createPortal(
    <div className="diagram-editor" role="dialog" aria-modal="true" aria-label="Draw.io editor">
      <div className="diagram-editor-bar">
        <strong className="diagram-editor-title">{state.title || "Diagram"}</strong>
        <span className="muted diagram-editor-hint">
          Draw.io. Save &amp; Exit returns you to where you were.
        </span>
        <span className="diagram-editor-grow" />
        {state.phase === "saving" ? (
          <span className="muted" role="status">
            Saving…
          </span>
        ) : null}
        {state.message && state.phase !== "failed" ? (
          <span className="error" role="alert">
            {state.message}
          </span>
        ) : null}
        {linked !== null && linked > 0 ? (
          <span className="diagram-chip linked">
            <LinkIcon size={12} />
            Linked in {plural(linked, "doc")}. One save updates{" "}
            {linked === 1 ? "it" : "all of them"}.
          </span>
        ) : null}
        {/* Once Draw.io is up its own Exit is the way out, so a stray click never drops work. */}
        {starting ? (
          <button
            type="button"
            className="button secondary small"
            onClick={() => props.onClose(null)}
          >
            Close
          </button>
        ) : null}
      </div>
      <div className="diagram-editor-stage">
        {/* Draw.io's frame is put in here by hand; React keeps this element empty. */}
        <div className="diagram-editor-frame" ref={stage} />
        {state.phase === "failed" ? (
          <div className="diagram-editor-panel" role="alert">
            <p>{state.message ?? "This diagram could not be opened."}</p>
            <button type="button" className="button" onClick={() => props.onClose(null)}>
              Close
            </button>
          </div>
        ) : null}
        {state.phase === "conflict" ? (
          <div className="diagram-editor-scrim">
            <div className="diagram-editor-panel" role="alertdialog" aria-label="Save conflict">
              <p>
                <strong>Someone else saved this diagram while you were editing.</strong>
              </p>
              <p className="muted">
                Overwrite keeps your drawing and replaces theirs. Reload opens theirs and drops the
                changes you made since you opened the editor.
              </p>
              <div className="diagram-editor-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => session.current?.resolveConflict("reload")}
                >
                  Reload theirs
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => session.current?.resolveConflict("overwrite")}
                >
                  Overwrite with mine
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
