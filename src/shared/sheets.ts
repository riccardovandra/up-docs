// Sheets in the library: the wire shapes of `/api/sheets` and of the sheet
// room's socket, shared by the Worker, the grid page and the MCP tools. The
// workbook itself (tabs, cells, edits, refusals) is the engine's, in `./sheet/`.

import type { Edit, Refusal, WorkbookRecords } from "./sheet/index.ts";

export const DEFAULT_SHEET_TITLE = "Untitled sheet";
export const MAX_SHEET_TITLE_LENGTH = 200;
/** Edits in one list; the engine also caps the cells one list writes. */
export const MAX_EDITS_PER_LIST = 500;
/** The longest `origin` (a client id) a request may carry. */
export const MAX_ORIGIN_LENGTH = 200;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isSheetId = (value: string) => ID.test(value);

/** A sheet as the library lists it: no tabs or cells. */
export interface SheetMeta {
  readonly id: string;
  /** Null for a sheet in no project. */
  readonly projectId: string | null;
  readonly title: string;
  /** Goes up by one with every applied edit list; a new sheet is at 0. */
  readonly revision: number;
  /** Null once the creator's account is gone. */
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Who sent an edit list: a person in the app, or an agent through a token. */
export interface SheetAuthor {
  readonly userId: string;
  /** The person's name, "" when they have not set one. */
  readonly name: string;
  readonly kind: "person" | "agent";
}

// ---- REST bodies ----

/** `GET /api/sheets?projectId=<id>|none`. */
export interface SheetListResponse {
  readonly sheets: ReadonlyArray<SheetMeta>;
}

/**
 * `GET /api/sheets/:id` and `POST /api/sheets` (201): the sheet's stored
 * records at `sheet.revision`. Rebuild the workbook with `workbookFromRecords`.
 */
export interface SheetResponse {
  readonly sheet: SheetMeta;
  readonly records: WorkbookRecords;
}

/** `PATCH /api/sheets/:id`. */
export interface SheetMetaResponse {
  readonly sheet: SheetMeta;
}

/** `POST /api/sheets/:id/edits` body. */
export interface SheetEditsRequest {
  readonly base: number;
  readonly edits: ReadonlyArray<Edit>;
  /** The sender's client id, echoed in the broadcast so it can skip its own. */
  readonly origin?: string | null;
}

/** `POST /api/sheets/:id/edits` 200. */
export interface SheetEditsApplied {
  readonly revision: number;
}

/**
 * `POST /api/sheets/:id/edits` refused: the engine's refusal, with HTTP 409 for
 * `baseIsNotTheRevision` and 400 for the rest. `revision` is the sheet's
 * revision now, so a client behind it knows how far.
 */
export interface SheetEditsRefused extends Refusal {
  readonly error: "edits_refused";
  readonly revision: number;
}

// ---- Socket: GET /api/sheets/:id/ws ----

/**
 * What the sheet room sends to every open socket, JSON per message.
 *
 * `sheet.revision`: an edit list was applied. Apply the same `edits` to a
 * workbook at `base` with `applyEdits(workbook, base, edits)` to land on
 * `revision`; the engine is deterministic, new tab ids included. A client
 * whose workbook is not at `base` missed a revision and re-reads the sheet.
 * `origin` is the sender's client id (null for agents and other callers).
 */
export type SheetRoomMessage =
  | {
      readonly type: "sheet.revision";
      readonly revision: number;
      readonly base: number;
      readonly edits: ReadonlyArray<Edit>;
      readonly origin: string | null;
      readonly by: SheetAuthor;
    }
  | { readonly type: "sheet.meta"; readonly sheet: SheetMeta; readonly origin: string | null }
  | { readonly type: "sheet.deleted"; readonly sheetId: string; readonly origin: string | null };

/** Close codes the sheet room uses. */
export const SHEET_SOCKET_CLOSE = {
  deleted: 4404,
  accessRemoved: 4403,
} as const;
