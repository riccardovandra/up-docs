// The client's calls to /api/diagrams, and a small notice board: every call
// that changes a diagram tells the pictures on the page, so they follow a save
// made anywhere (the editor overlay, a redraw, another component).

import type {
  DiagramListItem,
  DiagramSummary,
  DiagramUsage,
  DiagramView,
} from "../../shared/drawio.ts";
import { ApiError, request } from "../api.ts";

type DiagramListener = (diagram: DiagramSummary | null) => void;

const listeners = new Map<string, Set<DiagramListener>>();

/** Hears every change this page makes to the diagram; null when it is deleted. */
export function subscribeDiagram(diagramId: string, listener: DiagramListener): () => void {
  const set = listeners.get(diagramId) ?? new Set();
  set.add(listener);
  listeners.set(diagramId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(diagramId);
  };
}

function announce(diagramId: string, diagram: DiagramSummary | null): void {
  for (const listener of [...(listeners.get(diagramId) ?? [])]) listener(diagram);
}

const told = <A extends DiagramSummary>(diagram: A): A => {
  announce(diagram.id, diagram);
  return diagram;
};

/** A save refused because the source changed since `baseVersion`. */
export interface DiagramConflict {
  /** The version to save from to overwrite what is there. */
  readonly version: number;
  readonly diagram: DiagramSummary;
}

/** The conflict a 409 carries, or null for any other failure. */
export function diagramConflict(cause: unknown): DiagramConflict | null {
  if (!(cause instanceof ApiError) || cause.status !== 409) return null;
  const body = cause.body as Partial<DiagramConflict> & { readonly error?: string };
  return body.error === "version_conflict" && typeof body.version === "number" && body.diagram
    ? { version: body.version, diagram: body.diagram }
    : null;
}

/** Words for a failed call: the server's own sentence when it sent one. */
export function diagramErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const message = (cause.body as { readonly message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    if (cause.status === 403) return "Only the diagram's creator can change it.";
    if (cause.status === 404) return "This diagram no longer exists.";
  }
  return "The server could not be reached. Check your connection and try again.";
}

export interface DiagramPictureUpload {
  /** The version of the source the picture was drawn from. */
  readonly version: number;
  readonly svg: string;
  /** Base64, without a data URI prefix. Null when the browser could not make one. */
  readonly png: string | null;
}

export const diagramsApi = {
  /** The diagrams the caller manages. `projectId` narrows to one project, or to none with null. */
  list: async (projectId?: string | null): Promise<ReadonlyArray<DiagramListItem>> => {
    const query =
      projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId ?? "none")}`;
    return (await request<{ diagrams: Array<DiagramListItem> }>("GET", `/api/diagrams${query}`))
      .diagrams;
  },
  /** The diagram as the caller may see it: `xml` is null unless they manage it. */
  get: async (diagramId: string): Promise<DiagramView> =>
    (await request<{ diagram: DiagramView }>("GET", `/api/diagrams/${diagramId}`)).diagram,
  create: async (input: {
    readonly projectId: string | null;
    readonly title?: string;
    readonly xml?: string;
  }): Promise<DiagramView> =>
    told((await request<{ diagram: DiagramView }>("POST", "/api/diagrams", input)).diagram),
  /**
   * Renames, moves or saves a new source. A source needs `baseVersion`; a stale
   * one is refused with a 409 that `diagramConflict` reads.
   */
  update: async (
    diagramId: string,
    input: {
      readonly title?: string;
      readonly projectId?: string | null;
      readonly xml?: string;
      readonly baseVersion?: number;
    },
  ): Promise<DiagramView> =>
    told(
      (await request<{ diagram: DiagramView }>("PATCH", `/api/diagrams/${diagramId}`, input))
        .diagram,
    ),
  remove: async (diagramId: string): Promise<void> => {
    await request<{ ok: true }>("DELETE", `/api/diagrams/${diagramId}`);
    announce(diagramId, null);
  },
  /** The docs and tabs that link the diagram. Only for someone who manages it. */
  uses: (diagramId: string) => request<DiagramUsage>("GET", `/api/diagrams/${diagramId}/uses`),
  /** Stores the picture drawn from `version`. Refused with a 409 when the source has moved on. */
  uploadPicture: async (
    diagramId: string,
    picture: DiagramPictureUpload,
  ): Promise<DiagramSummary> =>
    told(
      (
        await request<{ diagram: DiagramSummary }>(
          "PUT",
          `/api/diagrams/${diagramId}/picture`,
          picture,
        )
      ).diagram,
    ),
};

export type DiagramsApi = typeof diagramsApi;
