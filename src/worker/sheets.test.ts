import { describe, expect, it } from "vitest";

import type { DocWithTabs } from "../shared/protocol.ts";
import {
  applyEdits,
  isRefusal,
  readCells,
  workbookFromRecords,
  workbookToRecords,
  type Edit,
  type Workbook,
  type WorkbookRecords,
} from "../shared/sheet/index.ts";
import type {
  SheetEditsRefused,
  SheetListResponse,
  SheetMetaResponse,
  SheetResponse,
} from "../shared/sheets.ts";
import * as Sheets from "./sheets.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie } });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as A };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const doc = (
    await send<DocWithTabs>(admin, "POST", "/api/docs", { projectId: project.id, title: "Plan" })
  ).body;
  /** Someone with an account (added to a doc) who did not make the sheet. */
  const person = async (email: string) => {
    await send(admin, "POST", `/api/docs/${doc.doc.id}/members`, { email, role: "editor" });
    return api.signIn(email);
  };
  const create = async (cookie = admin, body: Record<string, unknown> = {}) => {
    const created = await send<SheetResponse>(cookie, "POST", "/api/sheets", body);
    expect(created.status).toBe(201);
    return created.body;
  };
  const edit = (sheetId: string, base: number, edits: ReadonlyArray<Edit>, cookie = admin) =>
    send<{ revision: number } & Partial<SheetEditsRefused>>(
      cookie,
      "POST",
      `/api/sheets/${sheetId}/edits`,
      { base, edits, origin: "client-1" },
    );
  const get = async (sheetId: string) =>
    (await send<SheetResponse>(admin, "GET", `/api/sheets/${sheetId}`)).body;
  /** The sheet as a fresh client sees it: rebuilt from what GET returns. */
  const workbook = async (sheetId: string) => workbookFromRecords((await get(sheetId)).records);
  return { api, admin, project, person, create, edit, get, workbook, send };
}

const values = (workbook: Workbook, sheet: string, range: string) => {
  const read = readCells(workbook, sheet, range);
  if (isRefusal(read)) throw new Error(read.detail);
  return read.rows;
};

/** Records with cells in a stable order, to compare two workbooks' stored state. */
const sorted = (records: WorkbookRecords) => ({
  ...records,
  cells: [...records.cells].sort(
    (a, b) => a.sheetId.localeCompare(b.sheetId) || a.row - b.row || a.col - b.col,
  ),
});

describe("sheet library", () => {
  it("creates a sheet at revision 0 with one empty tab, and lists it for its creator", async () => {
    const { admin, project, create, send } = await setup();
    const { sheet, records } = await create(admin, { title: "Budget", projectId: project.id });
    expect(sheet).toMatchObject({ title: "Budget", projectId: project.id, revision: 0 });
    expect(records.revision).toBe(0);
    expect(records.sheets.map((tab) => [tab.id, tab.name, tab.rowCount, tab.columnCount])).toEqual([
      ["s0-0", "Sheet1", 1000, 26],
    ]);
    expect(records.cells).toEqual([]);

    const loose = await create(admin);
    expect(loose.sheet).toMatchObject({ title: "Untitled sheet", projectId: null });

    const list = async (query = "") =>
      (await send<SheetListResponse>(admin, "GET", `/api/sheets${query}`)).body.sheets.map(
        (item) => item.id,
      );
    expect((await list()).sort()).toEqual([sheet.id, loose.sheet.id].sort());
    expect(await list(`?projectId=${project.id}`)).toEqual([sheet.id]);
    expect(await list("?projectId=none")).toEqual([loose.sheet.id]);
  });

  it("hides a sheet from anyone but its creator and the admin", async () => {
    const { admin, person, create, send, edit } = await setup();
    const creator = await person("creator@example.com");
    const other = await person("other@example.com");
    const { sheet } = await create(creator, { title: "Mine" });

    expect((await send(other, "GET", `/api/sheets/${sheet.id}`)).status).toBe(404);
    expect((await edit(sheet.id, 0, [{ kind: "addSheet", name: "X" }], other)).status).toBe(404);
    expect((await send(other, "PATCH", `/api/sheets/${sheet.id}`, { title: "Ha" })).status).toBe(
      404,
    );
    expect((await send(other, "DELETE", `/api/sheets/${sheet.id}`)).status).toBe(404);
    expect((await send(other, "GET", `/api/sheets/${sheet.id}/export.csv`)).status).toBe(404);
    expect((await send<SheetListResponse>(other, "GET", "/api/sheets")).body.sheets).toEqual([]);

    expect((await send(creator, "GET", `/api/sheets/${sheet.id}`)).status).toBe(200);
    expect((await send(admin, "GET", `/api/sheets/${sheet.id}`)).status).toBe(200);
    expect((await send(admin, "GET", "/api/sheets/not%20an%20id")).status).toBe(404);
  });

  it("refuses a project the person cannot see", async () => {
    const { project, person, send } = await setup();
    const outsider = await person("outsider@example.com");
    // On the project's doc, so they can see it; a project id that does not exist cannot.
    expect(
      (await send(outsider, "POST", "/api/sheets", { projectId: project.id })).status,
    ).toBe(201);
    expect((await send(outsider, "POST", "/api/sheets", { projectId: "nope" })).status).toBe(404);
    expect((await send(outsider, "POST", "/api/sheets", { title: "" })).status).toBe(400);
  });

  it("renames and moves a sheet through its room, and tells open pages", async () => {
    const { api, admin, project, create, send } = await setup();
    const { sheet } = await create(admin, { title: "Draft" });
    api.clock.now += 5;
    const renamed = await send<SheetMetaResponse>(admin, "PATCH", `/api/sheets/${sheet.id}`, {
      title: "Final",
      projectId: project.id,
      origin: "tab-a",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.sheet).toMatchObject({
      title: "Final",
      projectId: project.id,
      updatedAt: sheet.updatedAt + 5,
    });
    expect(api.sheetBroadcasts.at(-1)).toEqual({
      sheetId: sheet.id,
      message: { type: "sheet.meta", sheet: renamed.body.sheet, origin: "tab-a" },
    });
    const moved = await send<SheetMetaResponse>(admin, "PATCH", `/api/sheets/${sheet.id}`, {
      projectId: null,
    });
    expect(moved.body.sheet).toMatchObject({ title: "Final", projectId: null });
    expect((await send(admin, "PATCH", `/api/sheets/${sheet.id}`, {})).status).toBe(400);
    expect((await send(admin, "PATCH", `/api/sheets/${sheet.id}`, { title: " " })).status).toBe(
      400,
    );
  });

  it("deletes a sheet with its tabs and cells, and closes its sockets", async () => {
    const { api, admin, create, edit, send } = await setup();
    const { sheet } = await create();
    await edit(sheet.id, 0, [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[1]] }]);
    const socket = await api.call("GET", `/api/sheets/${sheet.id}/ws`, {
      headers: { Cookie: admin, Upgrade: "websocket" },
    });
    expect(socket.status).toBe(204);
    expect(api.sheetSockets).toEqual([{ sheetId: sheet.id, userId: expect.any(String), open: true }]);

    expect((await send(admin, "DELETE", `/api/sheets/${sheet.id}?origin=tab-a`)).status).toBe(200);
    expect(api.sheetBroadcasts.at(-1)?.message).toEqual({
      type: "sheet.deleted",
      sheetId: sheet.id,
      origin: "tab-a",
    });
    expect(api.sheetSockets[0]!.open).toBe(false);
    expect((await send(admin, "GET", `/api/sheets/${sheet.id}`)).status).toBe(404);
    const count = async (table: string) =>
      (await api.db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    expect([await count("sheet_tabs"), await count("sheet_cells")]).toEqual([0, 0]);
  });

  it("moves a project's sheets with its docs", async () => {
    const { admin, project, create, send } = await setup();
    const { sheet } = await create(admin, { projectId: project.id });
    const moved = await send(admin, "POST", `/api/projects/${project.id}/move-docs`, {
      projectId: null,
    });
    expect(moved.status).toBe(200);
    const { body } = await send<SheetResponse>(admin, "GET", `/api/sheets/${sheet.id}`);
    expect(body.sheet.projectId).toBeNull();
  });
});

describe("sheet edits", () => {
  it("applies an edit list, bumps the revision and broadcasts the edits", async () => {
    const { api, create, edit, get } = await setup();
    const { sheet } = await create();
    api.clock.now += 10;
    const edits: Array<Edit> = [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[2, 3, "=A1*B1"]] },
    ];
    const applied = await edit(sheet.id, 0, edits);
    expect(applied).toEqual({ status: 200, body: { revision: 1 } });
    const after = await get(sheet.id);
    expect(after.sheet).toMatchObject({ revision: 1, updatedAt: sheet.updatedAt + 10 });
    expect(values(workbookFromRecords(after.records), "Sheet1", "A1:C1")).toEqual([
      [2, 3, { formula: "=A1*B1", value: 6 }],
    ]);
    expect(api.sheetBroadcasts).toEqual([
      {
        sheetId: sheet.id,
        message: {
          type: "sheet.revision",
          revision: 1,
          base: 0,
          edits,
          origin: "client-1",
          by: { userId: expect.any(String), name: expect.any(String), kind: "person" },
        },
      },
    ]);
  });

  it("refuses a second edit list on the same base with 409, writing nothing", async () => {
    const { api, create, edit, workbook } = await setup();
    const { sheet } = await create();
    const write = (value: string): Array<Edit> => [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[value]] },
    ];
    expect((await edit(sheet.id, 0, write("first"))).status).toBe(200);
    const second = await edit(sheet.id, 0, write("second"));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: "edits_refused",
      refusal: "baseIsNotTheRevision",
      editIndex: null,
      revision: 1,
    });
    expect(values(await workbook(sheet.id), "Sheet1", "A1")).toEqual([["first"]]);
    expect(api.sheetBroadcasts).toHaveLength(1);
    expect((await edit(sheet.id, 1, write("second"))).body).toEqual({ revision: 2 });
  });

  it("orders edit lists that arrive together: one lands, the other is refused", async () => {
    const { create, edit } = await setup();
    const { sheet } = await create();
    const results = await Promise.all(
      ["a", "b", "c"].map((name) => edit(sheet.id, 0, [{ kind: "addSheet", name }])),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409, 409]);
  });

  it("lands all edits of a list or none of them (400 with the edit's index)", async () => {
    const { api, create, edit, get } = await setup();
    const { sheet } = await create();
    const refused = await edit(sheet.id, 0, [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[1]] },
      { kind: "addSheet", name: "Data" },
      { kind: "renameSheet", sheet: "Nope", name: "X" },
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ refusal: "unknownSheet", editIndex: 2, revision: 0 });
    const after = await get(sheet.id);
    expect(after.sheet.revision).toBe(0);
    expect(after.records.cells).toEqual([]);
    expect(after.records.sheets.map((tab) => tab.name)).toEqual(["Sheet1"]);
    expect(api.sheetBroadcasts).toEqual([]);

    expect((await edit(sheet.id, 0, [])).body).toMatchObject({ refusal: "nothingToChange" });
    const malformed = await edit(sheet.id, 0, [{ kind: "nope" } as unknown as Edit]);
    expect(malformed.status).toBe(400);
    expect(malformed.body.refusal).toBe("badEdit");
  });

  it("checks the request before it reaches the room", async () => {
    const { admin, create, send } = await setup();
    const { sheet } = await create();
    const post = (body: unknown) => send(admin, "POST", `/api/sheets/${sheet.id}/edits`, body);
    expect((await post({ base: "0", edits: [] })).body).toEqual({ error: "invalid_base" });
    expect((await post({ base: 0, edits: {} })).body).toEqual({ error: "invalid_edits" });
    expect((await post({ base: 0, edits: [], origin: 5 })).body).toEqual({
      error: "invalid_origin",
    });
  });

  it("marks an edit list sent with an agent token as the agent's", async () => {
    const { api, admin, create } = await setup();
    const { sheet } = await create();
    const created = await api.call("POST", "/api/tokens", {
      body: { name: "agent" },
      headers: { Cookie: admin },
    });
    const { token } = (await created.json()) as { token: string };
    const response = await api.call("POST", `/api/sheets/${sheet.id}/edits`, {
      body: { base: 0, edits: [{ kind: "addSheet", name: "Agent" }] },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const message = api.sheetBroadcasts.at(-1)!.message;
    expect(message).toMatchObject({ type: "sheet.revision", origin: null, by: { kind: "agent" } });
  });

  it("persists across a dropped room: the reload from D1 has the same values and revision", async () => {
    const { api, create, edit, workbook } = await setup();
    const { sheet } = await create();
    const rows = [
      ["Item", "Price", "Qty", "Total"],
      ["Pens", "$1.50", 4, "=B2*C2"],
      ["Paper", "$3", 10, "=B3*C3"],
      ["", "", "", "=SUM(D2:D3)"],
    ];
    await edit(sheet.id, 0, [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows },
      { kind: "formatCells", sheet: "Sheet1", ranges: ["A1:D1"], format: { font: { bold: true } } },
      { kind: "setColumnWidths", sheet: "Sheet1", columns: ["A"], widthInPixels: 160 },
      { kind: "setSheetSettings", sheet: "Sheet1", settings: { lastFrozenRow: 1 } },
    ]);
    const before = await workbook(sheet.id);

    api.sheetEngines.delete(sheet.id);
    const reloaded = await workbook(sheet.id);
    expect(reloaded.revision).toBe(1);
    expect(values(reloaded, "Sheet1", "A1:D4")).toEqual(values(before, "Sheet1", "A1:D4"));
    expect(values(reloaded, "Sheet1", "D4")).toEqual([
      [{ formula: "=SUM(D2:D3)", value: 36 }],
    ]);
    const tab = reloaded.sheets[0]!;
    expect(tab.columnWidths).toEqual({ 0: 160 });
    expect(tab.settings.lastFrozenRow).toBe(1);
    expect(tab.cells.get(0)?.format).toEqual({ font: { bold: true } });

    // A new room loads the sheet from D1 and goes on from its revision.
    const next = await edit(sheet.id, 1, [
      { kind: "writeCells", sheet: "Sheet1", topLeft: "C2", rows: [[5]] },
    ]);
    expect(next.body).toEqual({ revision: 2 });
    expect(values(await workbook(sheet.id), "Sheet1", "D4")).toEqual([
      [{ formula: "=SUM(D2:D3)", value: 37.5 }],
    ]);
  });

  it("persists added, renamed, moved and deleted tabs, and rows inserted and deleted", async () => {
    const { api, create, edit, get } = await setup();
    const { sheet } = await create();
    let base = 0;
    const step = async (edits: Array<Edit>) => {
      const result = await edit(sheet.id, base, edits);
      expect(result.status).toBe(200);
      base = result.body.revision;
    };
    await step([
      { kind: "addSheet", name: "Data" },
      { kind: "addSheet", name: "Notes" },
      { kind: "writeCells", sheet: "Data", topLeft: "A1", rows: [[1], [2], [3]] },
      { kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [["=SUM(Data!A1:A3)"]] },
    ]);
    await step([
      { kind: "renameSheet", sheet: "Data", name: "Numbers" },
      { kind: "moveSheets", sheets: ["Notes"], afterSheet: null },
    ]);
    await step([{ kind: "insertRows", sheet: "Numbers", besideRow: 1, side: "before", count: 2 }]);
    await step([{ kind: "deleteRows", sheet: "Numbers", rows: [4] }]);
    await step([{ kind: "deleteSheet", sheet: "Notes" }]);

    api.sheetEngines.delete(sheet.id);
    const { records } = await get(sheet.id);
    const reloaded = workbookFromRecords(records);
    expect(reloaded.sheets.map((tab) => tab.name)).toEqual(["Sheet1", "Numbers"]);
    expect(records.sheets.map((tab) => [tab.name, tab.position])).toEqual([
      ["Sheet1", 0],
      ["Numbers", 1],
    ]);
    expect(values(reloaded, "Numbers", "A1:A4")).toEqual([[null], [null], [1], [3]]);
    expect(values(reloaded, "Sheet1", "A1")).toEqual([
      [{ formula: "=SUM(Numbers!A3:A4)", value: 4 }],
    ]);
  });

  it("lets a client replay each broadcast and land on the stored state", async () => {
    const { api, create, edit, get } = await setup();
    const created = await create();
    const sheetId = created.sheet.id;
    let client = workbookFromRecords(created.records);
    const lists: Array<Array<Edit>> = [
      [
        { kind: "writeCells", sheet: "Sheet1", topLeft: "B2", rows: [["10%", "=B2*100"]] },
        { kind: "addSheet", name: "Two" },
      ],
      [
        { kind: "writeCells", sheet: "Two", topLeft: "A1", rows: [["=Sheet1!C2"]] },
        { kind: "insertColumns", sheet: "Sheet1", besideColumn: "A", side: "before", count: 1 },
      ],
      [{ kind: "sortRows", sheet: "Sheet1", rows: ["1:3"], byColumn: "C", direction: "descending" }],
    ];
    for (const [index, edits] of lists.entries()) {
      expect((await edit(sheetId, index, edits)).status).toBe(200);
    }
    for (const { message } of api.sheetBroadcasts) {
      if (message.type !== "sheet.revision") continue;
      // As a client receives it: JSON over the socket.
      const { base, edits, revision } = JSON.parse(JSON.stringify(message)) as typeof message;
      const applied = applyEdits(client, base, edits);
      if (isRefusal(applied)) throw new Error(applied.detail);
      expect(applied.revision).toBe(revision);
      client = applied.workbook;
    }
    const stored = (await get(sheetId)).records;
    expect(sorted(workbookToRecords(client))).toEqual(sorted(stored));
  });

  it("writes a full edit list of long cells across several statements", async () => {
    const { create, edit, workbook } = await setup();
    const { sheet } = await create();
    const text = "x".repeat(500);
    const rows = Array.from({ length: 1000 }, (_, row) => [`${row} ${text}`, row]);
    expect((await edit(sheet.id, 0, [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows }])).status).toBe(200);
    const stored = await workbook(sheet.id);
    expect(stored.sheets[0]!.cells.size).toBe(2000);
    expect(values(stored, "Sheet1", "B1000")).toEqual([[999]]);
  });
});

describe("sheet store", () => {
  it("never writes changes on top of another revision", async () => {
    const { api, create, edit } = await setup();
    const { sheet } = await create();
    await edit(sheet.id, 0, [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[1]] }]);
    await expect(
      Sheets.writeSheetChanges(api.db, {
        sheetId: sheet.id,
        from: 0,
        now: 1,
        changes: {
          revision: 1,
          upsertSheets: [],
          deleteSheets: [],
          replaceCellsOf: [],
          upsertCells: [{ sheetId: "s0-0", row: 0, col: 0, input: "stale", format: null }],
          deleteCells: [],
        },
      }),
    ).rejects.toThrow();
    const { records } = await Sheets.loadSheet(api.db, sheet.id);
    expect(records.cells.map((cell) => cell.input)).toEqual(["1"]);
  });

  it("reads one revision's meta, tabs and cells", async () => {
    const { api, create, edit } = await setup();
    const { sheet } = await create();
    await edit(sheet.id, 0, [{ kind: "writeCells", sheet: "Sheet1", topLeft: "B3", rows: [["hi"]] }]);
    const loaded = await Sheets.loadSheet(api.db, sheet.id);
    expect(loaded.sheet.revision).toBe(1);
    expect(loaded.records).toMatchObject({
      revision: 1,
      cells: [{ sheetId: "s0-0", row: 2, col: 1, input: "hi", format: null }],
    });
    await expect(Sheets.loadSheet(api.db, "missing")).rejects.toThrow("not_found");
  });
});

describe("sheet export and socket", () => {
  it("exports one tab as CSV, values as shown", async () => {
    const { admin, api, create, edit } = await setup();
    const { sheet } = await create(admin, { title: "Q1 Budget" });
    await edit(sheet.id, 0, [
      {
        kind: "writeCells",
        sheet: "Sheet1",
        topLeft: "A1",
        rows: [
          ["Name", "Share", "Note"],
          ["Acme, Inc.", "12.5%", 'He said "hi"'],
          ["Total", "=B2", "two\nlines"],
        ],
      },
      { kind: "addSheet", name: "Other tab" },
      { kind: "writeCells", sheet: "Other tab", topLeft: "B2", rows: [["2026-03-15"]] },
    ]);
    const csv = (query = "") =>
      api.call("GET", `/api/sheets/${sheet.id}/export.csv${query}`, { headers: { Cookie: admin } });
    const first = await csv();
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(first.headers.get("Content-Disposition")).toBe(
      'attachment; filename="q1-budget-sheet1.csv"',
    );
    expect(await first.text()).toBe(
      'Name,Share,Note\r\n"Acme, Inc.",12.5%,"He said ""hi"""\r\nTotal,12.5%,"two\nlines"\r\n',
    );
    const other = await csv("?tab=other%20tab");
    expect(await other.text()).toBe(",\r\n,2026-03-15\r\n");
    expect((await csv("?tab=Missing")).status).toBe(404);
  });

  it("opens a socket only for someone who manages the sheet, from this origin", async () => {
    const { admin, api, create, person } = await setup();
    const { sheet } = await create();
    const open = (cookie: string, headers: Record<string, string> = {}) =>
      api.call("GET", `/api/sheets/${sheet.id}/ws`, {
        headers: { Cookie: cookie, Upgrade: "websocket", ...headers },
      });
    expect((await open(admin)).status).toBe(204);
    expect((await open(await person("x@example.com"))).status).toBe(404);
    expect((await open(admin, { Origin: "https://evil.test" })).status).toBe(403);
    const plain = await api.call("GET", `/api/sheets/${sheet.id}/ws`, { headers: { Cookie: admin } });
    expect(plain.status).toBe(426);
  });
});
