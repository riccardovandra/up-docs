// The client's calls to /api/sheets. Type-only imports from the engine, so the
// library page can list sheets without loading the formula engine.

import type { Edit } from "../../shared/sheet/types.ts";
import type {
  SheetEditsApplied,
  SheetEditsRefused,
  SheetListResponse,
  SheetMeta,
  SheetMetaResponse,
  SheetResponse,
} from "../../shared/sheets.ts";
import { ApiError, clientId, request } from "../api.ts";

export const SHEETS_PATH = "/sheets";

export const sheetPath = (sheetId: string, tabId?: string | null) =>
  tabId ? `${SHEETS_PATH}/${sheetId}/${encodeURIComponent(tabId)}` : `${SHEETS_PATH}/${sheetId}`;

/** What one POST of an edit list came back with. */
export type EditsOutcome =
  | { readonly kind: "applied"; readonly revision: number }
  /** 409: `base` was stale; the sheet is at `revision` now. */
  | { readonly kind: "stale"; readonly revision: number }
  /** 400: the engine refused the list against the sheet as it is. */
  | { readonly kind: "refused"; readonly refusal: SheetEditsRefused }
  /** Network failure or a server error: worth retrying. */
  | { readonly kind: "failed" }
  /** 404: deleted, or no longer this person's. */
  | { readonly kind: "gone" };

export async function postEdits(
  sheetId: string,
  base: number,
  edits: ReadonlyArray<Edit>,
): Promise<EditsOutcome> {
  try {
    const { revision } = await request<SheetEditsApplied>("POST", `/api/sheets/${sheetId}/edits`, {
      base,
      edits,
      origin: clientId,
    });
    return { kind: "applied", revision };
  } catch (cause) {
    if (!(cause instanceof ApiError)) return { kind: "failed" };
    const body = cause.body as Partial<SheetEditsRefused>;
    if (cause.status === 409 && typeof body.revision === "number") {
      return { kind: "stale", revision: body.revision };
    }
    if (cause.status === 404) return { kind: "gone" };
    if (cause.status === 400 && body.error === "edits_refused") {
      return { kind: "refused", refusal: body as SheetEditsRefused };
    }
    return cause.status >= 500 ? { kind: "failed" } : { kind: "refused", refusal: refusedOf(body) };
  }
}

function refusedOf(body: Partial<SheetEditsRefused>): SheetEditsRefused {
  return {
    error: "edits_refused",
    refusal: body.refusal ?? "badEdit",
    editIndex: body.editIndex ?? null,
    detail: body.detail ?? body.error ?? "The server refused the change.",
    revision: body.revision ?? -1,
  };
}

export const sheetsApi = {
  /** The sheets the caller manages, newest edit first. */
  list: async (): Promise<ReadonlyArray<SheetMeta>> =>
    (await request<SheetListResponse>("GET", "/api/sheets")).sheets,
  get: (sheetId: string) => request<SheetResponse>("GET", `/api/sheets/${sheetId}`),
  create: (input: { readonly projectId: string | null; readonly title?: string }) =>
    request<SheetResponse>("POST", "/api/sheets", input),
  rename: async (sheetId: string, title: string): Promise<SheetMeta> =>
    (
      await request<SheetMetaResponse>("PATCH", `/api/sheets/${sheetId}`, {
        title,
        origin: clientId,
      })
    ).sheet,
  move: async (sheetId: string, projectId: string | null): Promise<SheetMeta> =>
    (
      await request<SheetMetaResponse>("PATCH", `/api/sheets/${sheetId}`, {
        projectId,
        origin: clientId,
      })
    ).sheet,
  remove: async (sheetId: string): Promise<void> => {
    await request<{ ok: true }>(
      "DELETE",
      `/api/sheets/${sheetId}?origin=${encodeURIComponent(clientId)}`,
    );
  },
  /** A download link for one tab's shown values as CSV. */
  csvUrl: (sheetId: string, tabId: string) =>
    `/api/sheets/${sheetId}/export.csv?tab=${encodeURIComponent(tabId)}`,
};
