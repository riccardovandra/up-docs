// The client's calls to /api/designs. A save sends the .fig bytes then the PNG
// bytes as one application/octet-stream body, which the API accepts only from
// the app's origin.

import {
  designFigPath,
  designSavePath,
  type DesignListItem,
  type DesignSaveResult,
  type DesignView,
} from "../../shared/design.ts";
import { ApiError, request } from "../api.ts";

export type DesignListFilter = "all" | "yours" | "shared";

export const designsApi = {
  list: (filter: DesignListFilter = "all") =>
    request<{ designs: Array<DesignListItem> }>(
      "GET",
      filter === "all" ? "/api/designs" : `/api/designs?filter=${filter}`,
    ).then((body) => body.designs),
  get: (designId: string) =>
    request<{ design: DesignView }>("GET", `/api/designs/${designId}`).then((body) => body.design),
  create: (input: { readonly title?: string; readonly projectId: string | null }) =>
    request<{ design: DesignView }>("POST", "/api/designs", input).then((body) => body.design),
  rename: (designId: string, title: string) =>
    request<{ design: DesignView }>("PATCH", `/api/designs/${designId}`, { title }).then(
      (body) => body.design,
    ),
  move: (designId: string, projectId: string | null) =>
    request<{ design: DesignView }>("PATCH", `/api/designs/${designId}`, { projectId }).then(
      (body) => body.design,
    ),
  remove: (designId: string) => request<{ ok: true }>("DELETE", `/api/designs/${designId}`),
  /** The current .fig bytes and their version; null for a design with no file yet. */
  fig: async (
    designId: string,
  ): Promise<{ readonly bytes: ArrayBuffer; readonly version: number } | null> => {
    const response = await fetch(designFigPath(designId), { credentials: "same-origin" });
    if (response.status === 404) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (body.error === "no_file") return null;
      throw new ApiError(404, body);
    }
    if (!response.ok) throw new ApiError(response.status, {});
    const version = Number(response.headers.get("X-Design-Version"));
    return { bytes: await response.arrayBuffer(), version };
  },
  /** Stores a save as the next version; ApiError 409 `version_conflict` when it is stale. */
  save: async (
    designId: string,
    input: { readonly baseVersion: number; readonly fig: ArrayBuffer; readonly png: ArrayBuffer | null },
  ): Promise<DesignSaveResult> => {
    const response = await fetch(
      designSavePath(designId, { baseVersion: input.baseVersion, figBytes: input.fig.byteLength }),
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob(input.png ? [input.fig, input.png] : [input.fig]),
      },
    );
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new DesignSaveError(response.status, data as DesignSaveError["body"]);
    return data as DesignSaveResult;
  },
};

/** A refused save, with the newer design when it was stale. */
export class DesignSaveError extends ApiError {
  declare readonly body: { readonly error?: string; readonly message?: string; readonly design?: DesignView };
}

/** A refusal in words. */
export function designErrorText(cause: unknown): string {
  const body = cause instanceof ApiError ? (cause.body as { error?: string; message?: string }) : {};
  if (body.error === "version_conflict") {
    return "This design was saved somewhere else since it opened here.";
  }
  if (body.error === "design_too_large" || body.error === "invalid_design") {
    return body.message ?? "The design could not be stored.";
  }
  if (body.error === "forbidden") return "You can view this design but not change it.";
  if (cause instanceof ApiError) return "The server refused the save.";
  return "Could not reach UP Docs.";
}
