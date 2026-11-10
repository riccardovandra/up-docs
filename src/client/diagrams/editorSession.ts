// One sitting in the Draw.io editor, without the DOM: it answers the frame's
// events and saves through the API. On Save it takes the picture (SVG, then
// PNG), sends the source with the version it was drawn from, then uploads the
// picture. A new diagram is created by its first save, so Exit without saving
// leaves nothing behind.

import { DEFAULT_DIAGRAM_TITLE, type DiagramSummary } from "../../shared/drawio.ts";
import { ApiError } from "../api.ts";
import {
  announceDiagram,
  diagramConflict,
  diagramErrorMessage,
  type DiagramConflict,
  type DiagramsApi,
} from "./diagramsApi.ts";
import { exportDrawioPicture, type DrawioFrame, type DrawioPicture } from "./drawioFrame.ts";

export type DiagramEditorTarget =
  | { readonly kind: "existing"; readonly diagramId: string }
  /** Created in `projectId` (null: no project) by the first save. */
  | { readonly kind: "new"; readonly projectId: string | null; readonly title?: string };

export interface EditorSessionState {
  /**
   * `opening` until the diagram is on the canvas, `saving` during a save,
   * `conflict` when someone else saved first and the person must choose,
   * `failed` when the diagram could not be opened at all.
   */
  readonly phase: "opening" | "ready" | "saving" | "conflict" | "failed";
  readonly title: string;
  /** What went wrong with the last save or the open, in words for the person. */
  readonly message: string | null;
}

export interface EditorSession {
  /** After a `conflict`: save mine over theirs, or drop mine and load theirs. */
  resolveConflict(choice: "overwrite" | "reload"): void;
  /** Stops listening to the frame. The overlay calls it when it unmounts. */
  dispose(): void;
}

export function startEditorSession(options: {
  readonly frame: DrawioFrame;
  readonly api: Pick<DiagramsApi, "get" | "create" | "update" | "uploadPicture">;
  readonly target: DiagramEditorTarget;
  readonly onState: (state: EditorSessionState) => void;
  /** After every save that reached the server. */
  readonly onSaved?: (diagram: DiagramSummary) => void;
  /** The person is done. `saved` is the diagram as last saved here, or null if nothing was. */
  readonly onClose: (saved: DiagramSummary | null) => void;
}): EditorSession {
  const { frame, api, target } = options;
  let state: EditorSessionState = {
    phase: "opening",
    title: target.kind === "new" ? (target.title ?? DEFAULT_DIAGRAM_TITLE) : "",
    message: null,
  };
  /** Null until a new diagram's first save creates it. */
  let diagramId = target.kind === "existing" ? target.diagramId : null;
  let baseVersion = 0;
  let saved: DiagramSummary | null = null;
  let disposed = false;
  /** A save waiting on the person's answer to a conflict. */
  let held: {
    readonly xml: string;
    readonly picture: DrawioPicture | null;
    readonly exit: boolean;
    readonly conflict: DiagramConflict;
  } | null = null;

  const set = (next: Partial<EditorSessionState>) => {
    if (disposed) return;
    state = { ...state, ...next };
    options.onState(state);
  };
  const close = () => {
    if (!disposed) options.onClose(saved);
  };

  // The source to open: nothing for a new diagram, else the stored one, which
  // loads while Draw.io itself is still starting.
  const source: Promise<string> =
    target.kind === "new"
      ? Promise.resolve("")
      : api.get(target.diagramId).then((diagram) => {
          // Someone who only reads a doc that links it: the same answer the server gives a write.
          if (!diagram.canEdit || diagram.xml === null) {
            throw new ApiError(403, { error: "forbidden" });
          }
          baseVersion = diagram.version;
          set({ title: diagram.title });
          return diagram.xml;
        });
  source.catch(() => undefined);

  const open = async () => {
    try {
      frame.post({ action: "load", xml: await source, title: state.title });
    } catch (cause) {
      set({ phase: "failed", message: diagramErrorMessage(cause) });
    }
  };

  const persist = async (xml: string, picture: DrawioPicture | null, exit: boolean) => {
    set({ phase: "saving", message: null });
    try {
      const diagram =
        diagramId === null
          ? await api.create({
              projectId: target.kind === "new" ? target.projectId : null,
              title: state.title,
              xml,
            })
          : await api.update(diagramId, { xml, baseVersion });
      diagramId = diagram.id;
      baseVersion = diagram.version;
      saved = diagram;
      if (picture) {
        try {
          saved = await api.uploadPicture(diagram.id, { version: diagram.version, ...picture });
        } catch {
          // The source is safe. The picture is drawn again the next time the diagram is shown.
        }
      }
      if (disposed) return;
      options.onSaved?.(saved);
      frame.post({ action: "status", modified: false });
      if (exit) close();
      else set({ phase: "ready" });
    } catch (cause) {
      const conflict = diagramConflict(cause);
      if (conflict) {
        held = { xml, picture, exit, conflict };
        set({ phase: "conflict" });
        return;
      }
      // The drawing stays open, so nothing is lost.
      set({ phase: "ready", message: `Not saved. ${diagramErrorMessage(cause)}` });
    }
  };

  const save = async (xml: string, exit: boolean) => {
    if (state.phase !== "ready") return;
    set({ phase: "saving", message: null });
    // Without a picture the save still goes through; the picture is drawn on demand later.
    const picture = await exportDrawioPicture(frame, { spinKey: "saving" }).catch(() => null);
    await persist(xml, picture, exit);
  };

  const stop = frame.listen((event) => {
    if (event.event === "init") void open();
    else if (event.event === "load") {
      if (state.phase === "opening") set({ phase: "ready" });
    } else if (event.event === "save") void save(event.xml, event.exit);
    else if (event.event === "exit") close();
  });

  const reload = async () => {
    if (diagramId === null) return;
    set({ phase: "opening", message: null });
    try {
      const latest = await api.get(diagramId);
      // The page under the overlay still shows the version from before theirs.
      announceDiagram(latest);
      baseVersion = latest.version;
      set({ title: latest.title });
      frame.post({ action: "load", xml: latest.xml ?? "", title: latest.title });
    } catch (cause) {
      set({ phase: "failed", message: diagramErrorMessage(cause) });
    }
  };

  return {
    resolveConflict: (choice) => {
      const waiting = held;
      if (!waiting || state.phase !== "conflict") return;
      held = null;
      if (choice === "reload") {
        void reload();
        return;
      }
      baseVersion = waiting.conflict.version;
      void persist(waiting.xml, waiting.picture, waiting.exit);
    },
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}
