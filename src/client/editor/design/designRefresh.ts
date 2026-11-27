// Designs in docs (S4): one re-read for every design a page shows. Nothing
// pushes a design's saves to an open doc, so the page asks, on the triggers
// Draw.io blocks use: a slow timer while the page can be seen, and when the
// window or the tab comes back. One `GET /api/designs?ids=` covers every
// design on the page and never carries the file.

import {
  designRefreshPath,
  designUsesPath,
  MAX_DESIGN_REFRESH_IDS,
  type DesignRefresh,
  type DesignUsage,
} from "../../../shared/designBlock.ts";
import { request } from "../../api.ts";
import { designsApi } from "../../designs/designsApi.ts";
import { publicShare } from "../../publicMode.ts";

/** How often a page that can be seen asks. */
export const DESIGN_REFRESH_MS = 20_000;
/** A tab coming back sends focus and visibility together: one re-read answers both. */
const WAKE_GAP_MS = 2_000;

export const designDocsApi = {
  /** One design as a block shows it; ApiError 404 when it is gone or not shown to the person. */
  get: (designId: string) => designsApi.get(designId),
  /** The watched designs the person may see, by id. */
  reread: async (designIds: ReadonlyArray<string>): Promise<ReadonlyArray<DesignRefresh>> => {
    const found: Array<DesignRefresh> = [];
    for (let at = 0; at < designIds.length; at += MAX_DESIGN_REFRESH_IDS) {
      const ids = designIds.slice(at, at + MAX_DESIGN_REFRESH_IDS);
      const body = await request<{ designs: Array<DesignRefresh> }>("GET", designRefreshPath(ids));
      found.push(...body.designs);
    }
    return found;
  },
  /** The docs that show the design (editors of the design only). */
  uses: (designId: string) => request<DesignUsage>("GET", designUsesPath(designId)),
};

/**
 * What a re-read found for one design: the design, or null when it is gone
 * or no longer shown to the person.
 */
export type DesignHeard = (design: DesignRefresh | null) => void;

export interface DesignRefreshDeps {
  readonly reread: (designIds: ReadonlyArray<string>) => Promise<ReadonlyArray<DesignRefresh>>;
  readonly visible: () => boolean;
  /** Calls `wake` when the window gets the focus or the tab is shown again. */
  readonly onWake: (wake: () => void) => () => void;
  readonly now?: () => number;
  readonly setTimer?: (tick: () => void, ms: number) => () => void;
}

export interface DesignRefresher {
  /** Hears each re-read of `designId` while the block is on the page. */
  watch(designId: string, heard: DesignHeard): () => void;
  /** Re-reads now. */
  refresh(): Promise<void>;
}

export function createDesignRefresher(deps: DesignRefreshDeps): DesignRefresher {
  const listeners = new Map<string, Set<DesignHeard>>();
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((tick: () => void, ms: number) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    });
  let stop: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let startedAt = Number.NEGATIVE_INFINITY;

  const refresh = (): Promise<void> => {
    running ??= (async () => {
      startedAt = now();
      const ids = [...listeners.keys()];
      try {
        const seen = new Map((await deps.reread(ids)).map((design) => [design.id, design]));
        for (const id of ids) {
          for (const heard of [...(listeners.get(id) ?? [])]) heard(seen.get(id) ?? null);
        }
      } catch {
        // Offline or signed out: the page keeps what it shows; the next re-read tries again.
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const wake = () => {
    if (deps.visible() && now() - startedAt >= WAKE_GAP_MS) void refresh();
  };

  const sync = () => {
    if (listeners.size > 0 && !stop) {
      const untime = setTimer(wake, DESIGN_REFRESH_MS);
      const unwake = deps.onWake(wake);
      stop = () => {
        untime();
        unwake();
      };
    } else if (listeners.size === 0 && stop) {
      stop();
      stop = null;
    }
  };

  return {
    watch: (designId, heard) => {
      const set = listeners.get(designId) ?? new Set();
      set.add(heard);
      listeners.set(designId, set);
      sync();
      return () => {
        set.delete(heard);
        if (set.size === 0 && listeners.get(designId) === set) listeners.delete(designId);
        sync();
      };
    },
    refresh,
  };
}

let shared: DesignRefresher | null = null;

/** See `DesignRefresher.watch`. A public page has no session to re-read with. */
export function watchDesign(designId: string, heard: DesignHeard): () => void {
  if (publicShare()) return () => undefined;
  shared ??= createDesignRefresher({
    reread: designDocsApi.reread,
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
  return shared.watch(designId, heard);
}
