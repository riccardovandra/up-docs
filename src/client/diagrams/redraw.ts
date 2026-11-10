// Redraw on demand. An agent, or a save whose picture upload failed, leaves a
// diagram with a source and no current picture. The first browser that shows
// it, signed in as someone who manages it, draws the picture with one hidden
// Draw.io frame and uploads it. Diagrams queue through that one frame.

import { useSyncExternalStore } from "react";

import { isPictureCurrent, type DiagramSummary } from "../../shared/drawio.ts";
import { ApiError } from "../api.ts";
import { diagramConflict, diagramsApi, type DiagramsApi } from "./diagramsApi.ts";
import {
  DRAWIO_RENDERER_URL,
  exportDrawioPicture,
  mountDrawioFrame,
  nextDrawioEvent,
  type DrawioFrame,
} from "./drawioFrame.ts";

/** Draw.io has to download itself before it says `init`. */
const INIT_MS = 45_000;
const LOAD_MS = 20_000;
/** The frame is kept this long after the queue empties, then removed. */
const IDLE_MS = 30_000;

export interface RedrawDeps {
  /** Mounts the hidden frame. Called again after the frame was dropped. */
  readonly createFrame: () => DrawioFrame;
  readonly api: Pick<DiagramsApi, "get" | "uploadPicture">;
}

export interface RedrawQueue {
  /**
   * Draws and uploads the diagram's picture unless it is already current, and
   * resolves with the diagram as it then is. Asking again while a redraw of the
   * same diagram is queued returns that redraw. Rejects when the caller cannot
   * manage the diagram, or Draw.io does not answer.
   */
  request(diagramId: string): Promise<DiagramSummary>;
  /** Whether a redraw of the diagram is queued or under way. */
  isPending(diagramId: string): boolean;
  subscribe(listener: () => void): () => void;
}

export function createRedrawQueue(deps: RedrawDeps): RedrawQueue {
  const pending = new Map<string, Promise<DiagramSummary>>();
  const listeners = new Set<() => void>();
  let tail: Promise<unknown> = Promise.resolve();
  let frame: { readonly port: DrawioFrame; readonly ready: Promise<unknown> } | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const changed = () => {
    for (const listener of [...listeners]) listener();
  };

  const dropFrame = () => {
    frame?.port.remove();
    frame = null;
  };

  const readyFrame = async (): Promise<DrawioFrame> => {
    if (!frame) {
      const port = deps.createFrame();
      const ready = nextDrawioEvent(port, "init", { timeoutMs: INIT_MS, what: "start" });
      // Awaited below; this keeps a failure from surfacing as unhandled first.
      ready.catch(() => undefined);
      frame = { port, ready };
    }
    await frame.ready;
    return frame.port;
  };

  const draw = async (diagramId: string): Promise<DiagramSummary> => {
    const diagram = await deps.api.get(diagramId);
    if (isPictureCurrent(diagram)) return diagram;
    if (!diagram.canEdit || diagram.xml === null) {
      throw new Error("Only someone who manages the diagram can draw its picture.");
    }
    try {
      const port = await readyFrame();
      const loaded = nextDrawioEvent(port, "load", {
        timeoutMs: LOAD_MS,
        what: "open the diagram",
      });
      port.post({ action: "load", xml: diagram.xml });
      await loaded;
      const picture = await exportDrawioPicture(port);
      try {
        return await deps.api.uploadPicture(diagramId, { version: diagram.version, ...picture });
      } catch (cause) {
        // Saved again while we drew: this picture is of an older source. The
        // caller sees the diagram still behind and may ask once more.
        const conflict = diagramConflict(cause);
        if (conflict) return conflict.diagram;
        throw cause;
      }
    } catch (cause) {
      // A frame that timed out may be stuck on an error dialog; start the next one clean.
      if (!(cause instanceof ApiError)) dropFrame();
      throw cause;
    }
  };

  const request = (diagramId: string): Promise<DiagramSummary> => {
    const queued = pending.get(diagramId);
    if (queued) return queued;
    if (idle !== null) clearTimeout(idle);
    idle = null;
    const job = tail.then(() => draw(diagramId));
    tail = job.catch(() => undefined);
    pending.set(diagramId, job);
    changed();
    const done = () => {
      pending.delete(diagramId);
      if (pending.size === 0) idle = setTimeout(dropFrame, IDLE_MS);
      changed();
    };
    job.then(done, done);
    return job;
  };

  return {
    request,
    isPending: (diagramId) => pending.has(diagramId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared: RedrawQueue | null = null;

/** The page's one queue, with its one hidden frame. */
export function redrawQueue(): RedrawQueue {
  shared ??= createRedrawQueue({
    api: diagramsApi,
    createFrame: () =>
      mountDrawioFrame({
        url: DRAWIO_RENDERER_URL,
        parent: document.body,
        title: "Draw.io picture renderer",
        hidden: true,
      }),
  });
  return shared;
}

/** Draws the diagram's picture if it is missing or behind. See `RedrawQueue.request`. */
export const requestRedraw = (diagramId: string) => redrawQueue().request(diagramId);

/** Whether the diagram's picture is being drawn right now, for "Rendering diagram". */
export function useRedrawing(diagramId: string): boolean {
  const queue = redrawQueue();
  return useSyncExternalStore(queue.subscribe, () => queue.isPending(diagramId));
}
