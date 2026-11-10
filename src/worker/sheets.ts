// Sheets: the D1 store, who may see and change one, and the ordered write path
// every edit list takes. The REST API and the MCP tools both call
// `requireSheet`, `loadSheet`, `applySheetEdits`, `updateSheet` and
// `deleteSheet`, so both share one behaviour. A sheet is managed by its creator
// and the admin, like a diagram; nothing links a sheet into a doc yet, so
// nobody else sees one.
//
// Every write to one sheet runs in that sheet's SheetRoom (`SheetEngine` holds
// the logic, so tests run it without a Durable Object): it applies the edit
// list with the engine against `base`, writes the changes and the new revision
// to D1 in one batch, then broadcasts the edits to the sheet's open sockets.

import { isAdmin } from "../shared/access.ts";
import {
  applyEdits,
  createWorkbook,
  filledBounds,
  findSheet,
  isRefusal,
  recordChanges,
  viewCell,
  workbookFromRecords,
  workbookToRecords,
  type CellFormat,
  type CellRecord,
  type Edit,
  type RecordChanges,
  type Refusal,
  type SheetRecord,
  type SheetSettings,
  type Workbook,
  type WorkbookRecords,
} from "../shared/sheet/index.ts";
import {
  SHEET_SOCKET_CLOSE,
  type SheetAuthor,
  type SheetMeta,
  type SheetRoomMessage,
} from "../shared/sheets.ts";
import { randomId } from "./crypto.ts";
import { getProject, NotFoundError } from "./docs.ts";

// ---- access ----

/** The creator and the admin manage a sheet: see, edit, rename, move and delete it. */
export const canManageSheet = (sheet: Pick<SheetMeta, "createdBy">, userId: string) =>
  isAdmin(userId) || (sheet.createdBy !== null && sheet.createdBy === userId);

/**
 * The sheet, once `userId` is known to manage it. One they cannot is
 * NotFoundError, as with docs and diagrams, so ids do not reveal what exists.
 */
export async function requireSheet(
  db: D1Database,
  input: { readonly sheetId: string; readonly userId: string },
): Promise<SheetMeta> {
  const sheet = await getSheetMeta(db, input.sheetId);
  if (!canManageSheet(sheet, input.userId)) throw new NotFoundError("sheet");
  return sheet;
}

// ---- meta ----

interface SheetRow {
  id: string;
  project_id: string | null;
  title: string;
  revision: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const META_COLUMNS = "id, project_id, title, revision, created_by, created_at, updated_at";

const toMeta = (row: SheetRow): SheetMeta => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  revision: row.revision,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function getSheetMeta(db: D1Database, sheetId: string): Promise<SheetMeta> {
  const row = await db
    .prepare(`SELECT ${META_COLUMNS} FROM sheets WHERE id = ?`)
    .bind(sheetId)
    .first<SheetRow>();
  if (!row) throw new NotFoundError("sheet");
  return toMeta(row);
}

/**
 * The sheets a person manages, newest edit first: their own, or every sheet
 * for the admin. `projectId` narrows to one project, or to sheets in no
 * project when null.
 */
export async function listSheets(
  db: D1Database,
  input: { readonly userId: string; readonly projectId?: string | null | undefined },
): Promise<ReadonlyArray<SheetMeta>> {
  const { results } = await db
    .prepare(
      `SELECT ${META_COLUMNS} FROM sheets
       WHERE (?1 OR created_by = ?2) AND (?3 OR project_id IS ?4)
       ORDER BY updated_at DESC, id`,
    )
    .bind(
      isAdmin(input.userId) ? 1 : 0,
      input.userId,
      input.projectId === undefined ? 1 : 0,
      input.projectId ?? null,
    )
    .all<SheetRow>();
  return results.map(toMeta);
}

/**
 * Creates a sheet at revision 0 with the engine's one empty tab, "Sheet1".
 * The caller checks the person may use `projectId` (Access.canSeeProject).
 */
export async function createSheet(
  db: D1Database,
  input: {
    readonly projectId: string | null;
    readonly title: string;
    readonly createdBy: string;
    readonly now: number;
  },
): Promise<{ readonly sheet: SheetMeta; readonly records: WorkbookRecords }> {
  if (input.projectId !== null) await getProject(db, input.projectId);
  const sheet: SheetMeta = {
    id: randomId(),
    projectId: input.projectId,
    title: input.title,
    revision: 0,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const records = workbookToRecords(createWorkbook());
  await db.batch([
    db
      .prepare(
        `INSERT INTO sheets (id, project_id, title, revision, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(sheet.id, sheet.projectId, sheet.title, sheet.createdBy, sheet.createdAt, sheet.updatedAt),
    ...upsertTabStatements(db, sheet.id, records.sheets),
  ]);
  return { sheet, records };
}

/** Renames a sheet or moves it to another project (null: no project). */
export async function updateSheetMeta(
  db: D1Database,
  input: {
    readonly sheetId: string;
    readonly title?: string | undefined;
    readonly projectId?: string | null | undefined;
    readonly now: number;
  },
): Promise<SheetMeta> {
  if (input.projectId != null) await getProject(db, input.projectId);
  const row = await db
    .prepare(
      `UPDATE sheets SET
         title = COALESCE(?1, title),
         project_id = CASE WHEN ?2 THEN ?3 ELSE project_id END,
         updated_at = ?4
       WHERE id = ?5
       RETURNING ${META_COLUMNS}`,
    )
    .bind(
      input.title ?? null,
      input.projectId === undefined ? 0 : 1,
      input.projectId ?? null,
      input.now,
      input.sheetId,
    )
    .first<SheetRow>();
  if (!row) throw new NotFoundError("sheet");
  return toMeta(row);
}

/** Deletes the sheet with its tabs and cells. */
export async function deleteSheetRows(db: D1Database, sheetId: string): Promise<void> {
  const row = await db.prepare("DELETE FROM sheets WHERE id = ? RETURNING id").bind(sheetId).first();
  if (!row) throw new NotFoundError("sheet");
}

/** When a project's docs move out, its sheets go with them. */
export async function moveProjectSheets(
  db: D1Database,
  input: { readonly from: string; readonly to: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE sheets SET project_id = ?1 WHERE project_id = ?2")
    .bind(input.to, input.from)
    .run();
}

// ---- tabs and cells ----

interface TabRow {
  id: string;
  name: string;
  position: number;
  row_count: number;
  column_count: number;
  settings: string;
  column_widths: string;
  row_heights: string;
}

interface CellRow {
  tab_id: string;
  row: number;
  col: number;
  input: string;
  format: string | null;
}

/** The sheet as stored: its meta, and its tabs and cells at `sheet.revision`. */
export async function loadSheetRecords(
  db: D1Database,
  sheetId: string,
): Promise<{ readonly sheet: SheetMeta; readonly records: WorkbookRecords }> {
  // One batch is one transaction, so meta, tabs and cells are of one revision.
  const [meta, tabs, cells] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${META_COLUMNS} FROM sheets WHERE id = ?`).bind(sheetId),
    db
      .prepare(
        `SELECT id, name, position, row_count, column_count, settings, column_widths, row_heights
         FROM sheet_tabs WHERE sheet_id = ? ORDER BY position, id`,
      )
      .bind(sheetId),
    db
      .prepare("SELECT tab_id, row, col, input, format FROM sheet_cells WHERE sheet_id = ?")
      .bind(sheetId),
  ]);
  const row = meta?.results[0] as SheetRow | undefined;
  if (!row) throw new NotFoundError("sheet");
  const sheet = toMeta(row);
  const sheets = (tabs!.results as unknown as ReadonlyArray<TabRow>).map(
    (tab): SheetRecord => ({
      id: tab.id,
      name: tab.name,
      position: tab.position,
      rowCount: tab.row_count,
      columnCount: tab.column_count,
      settings: JSON.parse(tab.settings) as SheetSettings,
      columnWidths: JSON.parse(tab.column_widths) as Record<number, number>,
      rowHeights: JSON.parse(tab.row_heights) as Record<number, number>,
    }),
  );
  const cellRecords = (cells!.results as unknown as ReadonlyArray<CellRow>).map(
    (cell): CellRecord => ({
      sheetId: cell.tab_id,
      row: cell.row,
      col: cell.col,
      input: cell.input,
      format: cell.format === null ? null : (JSON.parse(cell.format) as CellFormat),
    }),
  );
  return { sheet, records: { revision: sheet.revision, sheets, cells: cellRecords } };
}

/**
 * Rows go to D1 as one JSON parameter per statement, read back with
 * json_each, so a large write is a handful of statements. A parameter must
 * stay under D1's 2 MB value limit; this leaves room for multibyte text.
 */
const MAX_CHUNK_CHARS = 400_000;

function chunked<A>(items: ReadonlyArray<A>, encode: (item: A) => string): Array<string> {
  const chunks: Array<string> = [];
  let parts: Array<string> = [];
  let size = 0;
  for (const item of items) {
    const part = encode(item);
    if (parts.length > 0 && size + part.length > MAX_CHUNK_CHARS) {
      chunks.push(`[${parts.join(",")}]`);
      parts = [];
      size = 0;
    }
    parts.push(part);
    size += part.length + 1;
  }
  if (parts.length > 0) chunks.push(`[${parts.join(",")}]`);
  return chunks;
}

function upsertTabStatements(
  db: D1Database,
  sheetId: string,
  tabs: ReadonlyArray<SheetRecord>,
): Array<D1PreparedStatement> {
  const encode = (tab: SheetRecord) =>
    JSON.stringify([
      tab.id,
      tab.name,
      tab.position,
      tab.rowCount,
      tab.columnCount,
      JSON.stringify(tab.settings),
      JSON.stringify(tab.columnWidths),
      JSON.stringify(tab.rowHeights),
    ]);
  // `WHERE true` keeps SQLite from reading ON CONFLICT as a join clause. An
  // upsert, never INSERT OR REPLACE, which would cascade-delete the tab's cells.
  return chunked(tabs, encode).map((chunk) =>
    db
      .prepare(
        `INSERT INTO sheet_tabs (sheet_id, id, name, position, row_count, column_count, settings,
           column_widths, row_heights)
         SELECT ?1, j.value->>0, j.value->>1, j.value->>2, j.value->>3, j.value->>4, j.value->>5,
           j.value->>6, j.value->>7
         FROM json_each(?2) j WHERE true
         ON CONFLICT (sheet_id, id) DO UPDATE SET name = excluded.name,
           position = excluded.position, row_count = excluded.row_count,
           column_count = excluded.column_count, settings = excluded.settings,
           column_widths = excluded.column_widths, row_heights = excluded.row_heights`,
      )
      .bind(sheetId, chunk),
  );
}

/**
 * The statements that take the stored sheet from revision `from` to
 * `changes.revision`. The first fails the whole batch (NOT NULL) unless the
 * stored revision is still `from`, so a write never lands on another one.
 */
function changeStatements(
  db: D1Database,
  input: {
    readonly sheetId: string;
    readonly from: number;
    readonly changes: RecordChanges;
    readonly now: number;
  },
): Array<D1PreparedStatement> {
  const { sheetId, changes } = input;
  const statements: Array<D1PreparedStatement> = [
    db
      .prepare(
        `UPDATE sheets SET revision = CASE WHEN revision = ?1 THEN ?2 ELSE NULL END, updated_at = ?3
         WHERE id = ?4`,
      )
      .bind(input.from, changes.revision, input.now, sheetId),
  ];
  if (changes.deleteSheets.length > 0) {
    statements.push(
      db
        .prepare(
          "DELETE FROM sheet_tabs WHERE sheet_id = ?1 AND id IN (SELECT value FROM json_each(?2))",
        )
        .bind(sheetId, JSON.stringify(changes.deleteSheets)),
    );
  }
  statements.push(...upsertTabStatements(db, sheetId, changes.upsertSheets));
  if (changes.replaceCellsOf.length > 0) {
    statements.push(
      db
        .prepare(
          "DELETE FROM sheet_cells WHERE sheet_id = ?1 AND tab_id IN (SELECT value FROM json_each(?2))",
        )
        .bind(sheetId, JSON.stringify(changes.replaceCellsOf)),
    );
  }
  for (const chunk of chunked(changes.deleteCells, (c) => JSON.stringify([c.sheetId, c.row, c.col]))) {
    statements.push(
      db
        .prepare(
          `DELETE FROM sheet_cells WHERE rowid IN (
             SELECT c.rowid FROM json_each(?2) j JOIN sheet_cells c
             ON c.sheet_id = ?1 AND c.tab_id = j.value->>0 AND c.row = j.value->>1
               AND c.col = j.value->>2)`,
        )
        .bind(sheetId, chunk),
    );
  }
  const encodeCell = (c: CellRecord) =>
    JSON.stringify([c.sheetId, c.row, c.col, c.input, c.format ? JSON.stringify(c.format) : null]);
  for (const chunk of chunked(changes.upsertCells, encodeCell)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sheet_cells (sheet_id, tab_id, row, col, input, format)
           SELECT ?1, j.value->>0, j.value->>1, j.value->>2, j.value->>3, j.value->>4
           FROM json_each(?2) j WHERE true
           ON CONFLICT (sheet_id, tab_id, row, col) DO UPDATE SET input = excluded.input,
             format = excluded.format`,
        )
        .bind(sheetId, chunk),
    );
  }
  return statements;
}

/** Writes an applied edit list in one D1 batch: all of it lands, or none. */
export async function writeSheetChanges(
  db: D1Database,
  input: {
    readonly sheetId: string;
    readonly from: number;
    readonly changes: RecordChanges;
    readonly now: number;
  },
): Promise<void> {
  await db.batch(changeStatements(db, input));
}

// ---- the ordered write path ----

export type SheetEditResult =
  | { readonly ok: true; readonly revision: number }
  /** Nothing was written. `revision` is the sheet's revision now. */
  | { readonly ok: false; readonly refusal: Refusal; readonly revision: number };

export interface SheetEditInput {
  readonly base: number;
  readonly edits: ReadonlyArray<Edit>;
  /** The sender's client id, null for callers without one (agents). */
  readonly origin: string | null;
  readonly by: SheetAuthor;
}

/** What a SheetEngine needs from its host: the Durable Object, or a test. */
export interface SheetRoomHost {
  readonly db: D1Database;
  broadcast(message: SheetRoomMessage): void;
  /** Closes every open socket on the sheet. */
  closeAll(code: number, reason: string): void;
  now(): number;
}

/**
 * One sheet's write path. Holds the sheet's workbook once loaded, so an edit
 * list is checked and applied without reading D1; every write goes through
 * here, so the copy stays current. Calls run one at a time, in arrival order.
 */
export class SheetEngine {
  private workbook: Workbook | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private readonly host: SheetRoomHost;
  readonly sheetId: string;

  constructor(host: SheetRoomHost, sheetId: string) {
    this.host = host;
    this.sheetId = sheetId;
  }

  // D1 calls are not covered by Durable Object input gates, so writes are
  // chained explicitly to keep them in arrival order.
  private serialize<A>(task: () => Promise<A>): Promise<A> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Workbook> {
    if (this.workbook) return this.workbook;
    const { records } = await loadSheetRecords(this.host.db, this.sheetId);
    this.workbook = workbookFromRecords(records);
    return this.workbook;
  }

  /** Drops the loaded workbook; the next call reads the sheet from D1 again. */
  forget(): void {
    this.workbook = null;
  }

  applyEdits(input: SheetEditInput): Promise<SheetEditResult> {
    return this.serialize(async () => {
      const workbook = await this.load();
      const applied = applyEdits(workbook, input.base, input.edits);
      if (isRefusal(applied)) return { ok: false, refusal: applied, revision: workbook.revision };
      try {
        await writeSheetChanges(this.host.db, {
          sheetId: this.sheetId,
          from: workbook.revision,
          changes: recordChanges(applied.workbook, applied.changed),
          now: this.host.now(),
        });
      } catch (cause) {
        // The stored sheet may not be what was loaded; read it again next time.
        this.workbook = null;
        throw cause;
      }
      this.workbook = applied.workbook;
      this.host.broadcast({
        type: "sheet.revision",
        revision: applied.revision,
        base: input.base,
        edits: input.edits,
        origin: input.origin,
        by: input.by,
      });
      return { ok: true, revision: applied.revision };
    });
  }

  updateMeta(input: {
    readonly title?: string | undefined;
    readonly projectId?: string | null | undefined;
    readonly origin: string | null;
  }): Promise<SheetMeta> {
    return this.serialize(async () => {
      const { origin, ...change } = input;
      const sheet = await updateSheetMeta(this.host.db, {
        sheetId: this.sheetId,
        ...change,
        now: this.host.now(),
      });
      this.host.broadcast({ type: "sheet.meta", sheet, origin });
      return sheet;
    });
  }

  /** Deletes the sheet, tells its open pages, then closes every socket. */
  deleteSheet(input: { readonly origin: string | null }): Promise<void> {
    return this.serialize(async () => {
      await deleteSheetRows(this.host.db, this.sheetId);
      this.workbook = null;
      this.host.broadcast({ type: "sheet.deleted", sheetId: this.sheetId, origin: input.origin });
      this.host.closeAll(SHEET_SOCKET_CLOSE.deleted, "sheet_deleted");
    });
  }
}

/** The ordered write path for a sheet; production routes it to the sheet's SheetRoom. */
export interface SheetRooms {
  applyEdits(sheetId: string, input: SheetEditInput): Promise<SheetEditResult>;
  updateMeta(
    sheetId: string,
    input: {
      readonly title?: string | undefined;
      readonly projectId?: string | null | undefined;
      readonly origin: string | null;
    },
  ): Promise<SheetMeta>;
  deleteSheet(sheetId: string, input: { readonly origin: string | null }): Promise<void>;
  /** `userId` tags the socket, for S4's presence. */
  openSocket(sheetId: string, request: Request, userId: string): Promise<Response>;
}

// ---- entry points for REST and MCP (access checked by the caller with requireSheet) ----

/** The sheet's meta and stored records, read from D1 at one revision. */
export const loadSheet = (db: D1Database, sheetId: string) => loadSheetRecords(db, sheetId);

/** Applies one edit list through the sheet's room. */
export const applySheetEdits = (
  rooms: SheetRooms,
  sheetId: string,
  input: SheetEditInput,
): Promise<SheetEditResult> => rooms.applyEdits(sheetId, input);

/** Who an edit list is from, for the broadcast. */
export async function sheetAuthor(
  db: D1Database,
  principal: { readonly kind: "session" | "token"; readonly userId: string },
): Promise<SheetAuthor> {
  const row = await db
    .prepare("SELECT name FROM users WHERE id = ?")
    .bind(principal.userId)
    .first<{ name: string }>();
  return {
    userId: principal.userId,
    name: row?.name ?? "",
    kind: principal.kind === "token" ? "agent" : "person",
  };
}

// ---- CSV ----

const csvField = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

/**
 * One tab as CSV, values as the grid shows them, from A1 to the last filled
 * row and column. `tab` is a tab id or name; absent, the first tab. Null when
 * there is no such tab.
 */
export function sheetCsv(
  workbook: Workbook,
  tab: string | null,
): { readonly name: string; readonly csv: string } | null {
  const sheet = tab === null ? workbook.sheets[0] : findSheet(workbook, tab);
  if (!sheet) return null;
  const bounds = filledBounds(sheet);
  const lines: Array<string> = [];
  if (bounds) {
    for (let row = 0; row <= bounds.r2; row++) {
      const fields: Array<string> = [];
      for (let col = 0; col <= bounds.c2; col++) {
        fields.push(csvField(viewCell(workbook, sheet.id, row, col).shown));
      }
      lines.push(fields.join(","));
    }
  }
  return { name: sheet.name, csv: lines.map((line) => `${line}\r\n`).join("") };
}
