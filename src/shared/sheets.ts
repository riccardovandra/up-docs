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
  | { readonly type: "sheet.deleted"; readonly sheetId: string; readonly origin: string | null }
  /** Sent once to a socket when it opens: itself, and everyone else already here. */
  | {
      readonly type: "sheet.presence.snapshot";
      readonly self: SheetPresence;
      readonly presences: ReadonlyArray<SheetPresence>;
    }
  /** Another page joined, moved its selection, switched tab or cleared. Replaces that connection's last one. */
  | ({ readonly type: "sheet.presence" } & SheetPresence)
  /** Another page closed. */
  | { readonly type: "sheet.presence.left"; readonly connectionId: string };

/** Close codes the sheet room uses. */
export const SHEET_SOCKET_CLOSE = {
  deleted: 4404,
  accessRemoved: 4403,
} as const;

// ---- Presence: who has the sheet open, and where ----

/**
 * One open page in the room, as everyone else sees it. A person with the sheet
 * open in two windows is two presences with the same `userId`, `name` and
 * colour. `tabId`, `range` and `activeCell` are null until the page says
 * where it is, or after it clears.
 */
export interface SheetPresence {
  /** The room's id for this socket, fresh per connection. */
  readonly connectionId: string;
  readonly userId: string;
  /** The person's name, "" when they have not set one. */
  readonly name: string;
  /** Index into the presence palette, the same for a user everywhere. */
  readonly colorIndex: number;
  readonly tabId: string | null;
  /** A1 text of the selection: "B2", "B2:C4", "3:5" or "B:D". */
  readonly range: string | null;
  /** The selection's active cell, "B2". */
  readonly activeCell: string | null;
}

/**
 * Liveness: a page re-sends its presence every `PRESENCE_HEARTBEAT_MS`. A page
 * the room has not heard from for `PRESENCE_EXPIRY_MS` is gone (a closed
 * laptop, a page unloaded without a close frame): the room announces it left,
 * and pages drop a cursor they have not heard of for as long. The expiry
 * outlasts a background tab, whose timers a browser may run once a minute.
 */
export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_EXPIRY_MS = 75_000;

/** Colours a presence can take; `colorIndex` is below this. */
export const PRESENCE_COLORS = 8;

/** A stable colour for a user: a hash of the user id into the palette. */
export function presenceColorIndex(userId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % PRESENCE_COLORS;
}

/**
 * What a page may send the room, JSON per message. Only presence: edits go
 * through `POST /api/sheets/:id/edits`. The room takes the sender from the
 * socket, never from the message.
 *
 * `presence`: the page shows tab `tabId` with `range` selected. `presence.clear`:
 * the page is open but shows no selection (it stays in the room's avatars).
 */
export type SheetClientMessage =
  | {
      readonly type: "presence";
      readonly tabId: string;
      readonly range: string;
      readonly activeCell: string;
    }
  | { readonly type: "presence.clear" };

/** Longest presence message the room reads; anything longer is dropped. */
export const MAX_PRESENCE_MESSAGE_LENGTH = 512;

const CELL = "[A-Z]{1,3}[1-9][0-9]{0,6}";
const RANGE = new RegExp(`^(?:${CELL}(?::${CELL})?|[A-Z]{1,3}:[A-Z]{1,3}|[1-9][0-9]{0,6}:[1-9][0-9]{0,6})$`);
const ACTIVE_CELL = new RegExp(`^${CELL}$`);

/** Reads a page's message, or null when it is not a well-formed one. */
export function parseSheetClientMessage(text: string): SheetClientMessage | null {
  if (text.length > MAX_PRESENCE_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "presence.clear") return { type: "presence.clear" };
  if (message.type !== "presence") return null;
  const { tabId, range, activeCell } = message;
  if (typeof tabId !== "string" || !isSheetId(tabId)) return null;
  if (typeof range !== "string" || !RANGE.test(range)) return null;
  if (typeof activeCell !== "string" || !ACTIVE_CELL.test(activeCell)) return null;
  return { type: "presence", tabId, range, activeCell };
}
