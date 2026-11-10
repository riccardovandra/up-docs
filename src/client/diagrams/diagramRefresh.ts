// One re-read for the whole page. Nothing pushes a diagram's changes to an open
// page, so the page asks: on a slow timer while it can be seen, when the window
// or the tab comes back, and when the Draw.io editor closes. One request covers
// every diagram the page shows and never carries a source. What it finds goes to
// the notice board in `diagramsApi.ts`, which the pictures and blocks hear.

import type { DiagramRefresh } from "../../shared/drawio.ts";
import { diagramsApi, rereadDiagrams, type DiagramsApi } from "./diagramsApi.ts";

/** How often a page that can be seen asks. */
export const DIAGRAM_REFRESH_MS = 20_000;
/** A tab coming back sends focus and visibility together: one re-read answers both. */
const WAKE_GAP_MS = 2_000;

/** What a re-read found, by id: the watched diagrams the person may see. */
export type RefreshListener = (seen: ReadonlyMap<string, DiagramRefresh>) => void;

export interface RefreshDeps {
  readonly api: Pick<DiagramsApi, "summaries">;
  /** Whether the page can be seen right now. */
  readonly visible: () => boolean;
  /** Calls `wake` when the window gets the focus or the tab is shown again. */
  readonly onWake: (wake: () => void) => () => void;
}

export interface DiagramRefresher {
  /** Keeps the diagram in the re-read while something on the page shows it. */
  watch(diagramId: string): () => void;
  /**
   * Hears every re-read that reached the server. A list re-reads itself on it;
   * a block takes where its diagram is linked from `seen`.
   */
  subscribe(listener: RefreshListener): () => void;
  /** Re-reads now, or once more after the re-read under way. Resolves when the page was told. */
  refresh(): Promise<void>;
}

export function createDiagramRefresher(deps: RefreshDeps): DiagramRefresher {
  /** How many things on the page show each diagram. */
  const watched = new Map<string, number>();
  const listeners = new Set<RefreshListener>();
  let stop: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let startedAt = Number.NEGATIVE_INFINITY;

  const reread = async () => {
    startedAt = Date.now();
    try {
      // Null: a save on this page crossed the read. Lists still re-read; blocks wait a turn.
      const seen = (await rereadDiagrams(deps.api, [...watched.keys()])) ?? new Map();
      for (const listener of [...listeners]) listener(seen);
    } catch {
      // Offline or signed out: the page keeps what it shows, and the next re-read tries again.
    }
  };

  const refresh = (): Promise<void> => {
    // Asked during a re-read: that one may predate what the caller knows, so one more follows.
    again = running !== null;
    running ??= (async () => {
      do {
        again = false;
        await reread();
      } while (again);
      running = null;
    })();
    return running;
  };

  /** The timer's tick, and the window coming back: only while the page can be seen. */
  const wake = () => {
    if (deps.visible() && Date.now() - startedAt >= WAKE_GAP_MS) void refresh();
  };

  /** One timer for the page, and only while something on it shows a diagram. */
  const sync = () => {
    const wanted = watched.size > 0 || listeners.size > 0;
    if (wanted && !stop) {
      const timer = setInterval(wake, DIAGRAM_REFRESH_MS);
      const unwake = deps.onWake(wake);
      stop = () => {
        clearInterval(timer);
        unwake();
      };
    } else if (!wanted && stop) {
      stop();
      stop = null;
    }
  };

  return {
    watch: (diagramId) => {
      watched.set(diagramId, (watched.get(diagramId) ?? 0) + 1);
      sync();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        const count = (watched.get(diagramId) ?? 1) - 1;
        if (count > 0) watched.set(diagramId, count);
        else watched.delete(diagramId);
        sync();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      sync();
      return () => {
        listeners.delete(listener);
        sync();
      };
    },
    refresh,
  };
}

let shared: DiagramRefresher | null = null;

/** The page's one refresher, with its one timer. */
function refresher(): DiagramRefresher {
  shared ??= createDiagramRefresher({
    api: diagramsApi,
    visible: () => document.visibilityState === "visible",
    onWake: (wake) => {
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("focus", wake);
      return () => {
        document.removeEventListener("visibilitychange", wake);
        window.removeEventListener("focus", wake);
      };
    },
  });
  return shared;
}

/** See `DiagramRefresher.watch`. */
export const watchDiagram = (diagramId: string) => refresher().watch(diagramId);
/** See `DiagramRefresher.subscribe`. */
export const subscribeRefresh = (listener: RefreshListener) => refresher().subscribe(listener);
/** See `DiagramRefresher.refresh`. */
export const refreshDiagrams = () => refresher().refresh();
