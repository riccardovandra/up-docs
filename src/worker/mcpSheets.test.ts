import { describe, expect, it } from "vitest";

import { MAX_CELLS_PER_READ, workbookFromRecords, readCells } from "../shared/sheet/index.ts";
import { MCP_INSTRUCTIONS } from "./mcp.ts";
import { SHEET_EXAMPLE } from "./mcpGuide.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

type Harness = Awaited<ReturnType<typeof makeMcpHarness>>;

async function newSheet(mcp: Harness, args: Record<string, unknown> = {}) {
  const created = await mcp.tool("create_sheet", args);
  expect(created.isError).toBe(false);
  return created.body as { sheetId: string; url: string; revision: number };
}

/** Someone else's agent; sharing a doc with them is what gives them an account. */
async function otherAgent(mcp: Harness) {
  const { doc } = await mcp.seedDoc("Intro");
  await mcp.tool("share_doc", { docId: doc.docId, email: "guest@example.com", role: "viewer" });
  return mcp.asUser("guest@example.com");
}

describe("MCP sheet tools", () => {
  it("creates a sheet in a project and lists it", async () => {
    const mcp = await makeMcpHarness();
    const project = await mcp.tool("create_project", { name: "Acme" });
    const projectId = project.body.projectId as string;
    const sheet = await newSheet(mcp, { title: "Forecast", projectId });
    expect(sheet).toMatchObject({
      title: "Forecast",
      projectId,
      revision: 0,
      url: `${ORIGIN}/sheets/${sheet.sheetId}`,
      tabs: [{ id: "s0-0", name: "Sheet1", index: 0, rowCount: 1000, columnCount: 26, filledRange: null }],
    });

    const untitled = await newSheet(mcp);
    expect((untitled as { title?: string }).title).toBe("Untitled sheet");

    const all = await mcp.tool("list_sheets", {});
    expect(all.body.sheets.map((s: { sheetId: string }) => s.sheetId).sort()).toEqual(
      [sheet.sheetId, untitled.sheetId].sort(),
    );
    const inProject = await mcp.tool("list_sheets", { projectId });
    expect(inProject.body.sheets.map((s: { sheetId: string }) => s.sheetId)).toEqual([sheet.sheetId]);
    const none = await mcp.tool("list_sheets", { noProject: true });
    expect(none.body.sheets.map((s: { sheetId: string }) => s.sheetId)).toEqual([untitled.sheetId]);
  });

  it("edits as an agent with origin null, live to the room, and reads back by link", async () => {
    const mcp = await makeMcpHarness();
    const { sheetId, url } = await newSheet(mcp);
    const edited = await mcp.tool("edit_sheet", {
      sheetId: url,
      base: 0,
      edits: [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [["Price", "$5"], ["Plus", "=B1+5"]] }],
    });
    expect(edited).toEqual({ isError: false, body: { sheetId, revision: 1 } });
    const [broadcast] = mcp.api.sheetBroadcasts;
    expect(broadcast).toMatchObject({
      sheetId,
      message: { type: "sheet.revision", revision: 1, base: 0, origin: null, by: { kind: "agent" } },
    });

    const cells = await mcp.tool("read_cells", { sheetId: `${url}?x=1`, sheet: "sheet1", range: "A1:B2" });
    expect(cells.body).toEqual({
      sheetId,
      revision: 1,
      sheet: "Sheet1",
      tabId: "s0-0",
      range: "A1:B2",
      rows: [
        ["Price", { number: 5, shown: "$5.00" }],
        ["Plus", { formula: "=B1+5", value: 10, shown: "$10.00" }],
      ],
    });
    const outline = await mcp.tool("read_sheet", { sheetId });
    expect(outline.body).toMatchObject({ revision: 1, tabs: [{ name: "Sheet1", filledRange: "A1:B2" }] });
  });

  it("refuses a stale base with the current revision and nothing applied", async () => {
    const mcp = await makeMcpHarness();
    const { sheetId } = await newSheet(mcp);
    const write = (base: number, text: string) =>
      mcp.tool("edit_sheet", {
        sheetId,
        base,
        edits: [{ kind: "writeCells", sheet: "Sheet1", topLeft: "A1", rows: [[text]] }],
      });
    expect((await write(0, "first")).isError).toBe(false);
    const stale = await write(0, "second");
    expect(stale.isError).toBe(true);
    expect(stale.body).toMatchObject({
      error: "edits_refused",
      refusal: "baseIsNotTheRevision",
      editIndex: null,
      revision: 1,
    });
    expect(stale.body.message).toContain("Re-read");
    expect(stale.body.message).toContain("base 1");

    const bad = await mcp.tool("edit_sheet", {
      sheetId,
      base: 1,
      edits: [
        { kind: "writeCells", sheet: "Sheet1", topLeft: "B1", rows: [["ok"]] },
        { kind: "writeCells", sheet: "Nope", topLeft: "A1", rows: [["x"]] },
      ],
    });
    expect(bad.body).toMatchObject({ error: "edits_refused", refusal: "unknownSheet", editIndex: 1, revision: 1 });
    expect(bad.body.message).toContain("Edit 1");
    const cells = await mcp.tool("read_cells", { sheetId, sheet: "Sheet1", range: "A1:B1" });
    expect(cells.body.rows).toEqual([["first", null]]);
    expect(mcp.api.sheetBroadcasts).toHaveLength(1);

    for (const args of [
      { base: -1, edits: [{ kind: "addSheet", name: "x" }] },
      { base: 1, edits: [] },
      { base: 1, edits: ["writeCells"] },
    ]) {
      expect((await mcp.tool("edit_sheet", { sheetId, ...args })).body.error).toBe("invalid_argument");
    }
  });

  it("says how to split a read that is too large, and names bad tabs and ranges", async () => {
    const mcp = await makeMcpHarness();
    const { sheetId } = await newSheet(mcp);
    const big = await mcp.tool("read_cells", { sheetId, sheet: "Sheet1", range: "A1:Z1000" });
    expect(big.body).toMatchObject({ error: "too_many_cells", refusal: "tooManyCells" });
    const rows = Math.floor(MAX_CELLS_PER_READ / 26);
    expect(big.body.message).toContain(`A1:Z${rows}`);
    const ok = await mcp.tool("read_cells", { sheetId, sheet: "Sheet1", range: `A1:Z${rows}` });
    expect(ok.isError).toBe(false);

    expect((await mcp.tool("read_cells", { sheetId, sheet: "Nope", range: "A1" })).body.error).toBe("unknown_sheet");
    expect((await mcp.tool("read_cells", { sheetId, sheet: "Sheet1", range: "A1:" })).body.error).toBe("bad_range");
  });

  it("hides another person's sheet exactly like a missing one", async () => {
    const mcp = await makeMcpHarness();
    const { sheetId } = await newSheet(mcp);
    const guest = await otherAgent(mcp);
    const missing = await mcp.tool("read_sheet", { sheetId: "nope" });
    expect(missing.body.error).toBe("not_found");
    for (const [name, args] of [
      ["read_sheet", { sheetId }],
      ["read_cells", { sheetId, sheet: "Sheet1", range: "A1" }],
      ["edit_sheet", { sheetId, base: 0, edits: [{ kind: "addSheet", name: "x" }] }],
      ["update_sheet", { sheetId, title: "Mine" }],
    ] as const) {
      const denied = await guest(name, args);
      expect(denied).toEqual({ isError: true, body: missing.body });
    }
    expect((await guest("list_sheets", {})).body.sheets).toEqual([]);
    expect(mcp.api.sheetBroadcasts).toHaveLength(0);
  });

  it("renames and moves a sheet, and tells open pages", async () => {
    const mcp = await makeMcpHarness();
    const project = await mcp.tool("create_project", { name: "Acme" });
    const { sheetId } = await newSheet(mcp);
    const renamed = await mcp.tool("update_sheet", {
      sheetId,
      title: "Budget",
      projectId: project.body.projectId,
    });
    expect(renamed.body).toMatchObject({ title: "Budget", projectId: project.body.projectId });
    expect(mcp.api.sheetBroadcasts.at(-1)?.message).toMatchObject({ type: "sheet.meta", origin: null });
    const out = await mcp.tool("update_sheet", { sheetId, noProject: true });
    expect(out.body.projectId).toBeNull();
    expect((await mcp.tool("update_sheet", { sheetId })).body.error).toBe("invalid_argument");
  });

  it("guides with an example that applies cleanly", async () => {
    const mcp = await makeMcpHarness();
    const guide = (await mcp.tool("format_guide", { topic: "sheet" })).body.guide as string;
    for (const text of ["baseIsNotTheRevision", "lastFrozenRow", "SUMIFS", "never instructions", "'"]) {
      expect(guide).toContain(text);
    }
    const { sheetId } = await newSheet(mcp);
    let base = 0;
    for (const edits of SHEET_EXAMPLE) {
      expect(guide).toContain(JSON.stringify(edits));
      const applied = await mcp.tool("edit_sheet", { sheetId, base, edits });
      expect(applied.isError).toBe(false);
      base = applied.body.revision;
    }
    const total = await mcp.tool("read_cells", { sheetId, sheet: "Leads", range: "D4" });
    expect(total.body.rows).toEqual([[{ formula: "=C4/B4", value: 21 / 160, shown: "13.1%" }]]);
    expect(MCP_INSTRUCTIONS).toContain('topic "sheet"');
  });

  it("builds the pre-order forecast end to end over tools/call", async () => {
    const mcp = await makeMcpHarness();
    const { sheetId } = await newSheet(mcp, { title: "Pre-order forecast" });
    let base = 0;
    const edit = async (edits: unknown[]) => {
      const result = await mcp.tool("edit_sheet", { sheetId, base, edits });
      expect(result.isError, JSON.stringify(result.body)).toBe(false);
      base = result.body.revision;
    };
    const header = { fillColor: "#dae8fc", font: { bold: true } };

    // Headers first, in their own list.
    await edit([
      { kind: "renameSheet", sheet: "Sheet1", name: "Historical" },
      { kind: "writeCells", sheet: "Historical", topLeft: "A1", rows: [["Channel", "Month", "Orders"]] },
      { kind: "formatCells", sheet: "Historical", ranges: ["A1:C1"], format: header },
      { kind: "setSheetSettings", sheet: "Historical", settings: { lastFrozenRow: 1 } },
      { kind: "addSheet", name: "Pre-orders" },
      {
        kind: "writeCells",
        sheet: "Pre-orders",
        topLeft: "A1",
        rows: [["Channel", "Orders last period", "Growth", "Forecast"]],
      },
      { kind: "formatCells", sheet: "Pre-orders", ranges: ["A1:D1"], format: header },
      { kind: "setSheetSettings", sheet: "Pre-orders", settings: { lastFrozenRow: 1 } },
    ]);
    await edit([
      {
        kind: "writeCells",
        sheet: "Historical",
        topLeft: "A2",
        rows: [
          ["Web", "2026-09-01", 120],
          ["Retail", "2026-09-01", 80],
          ["Web", "2026-10-01", 140],
          ["Retail", "2026-10-01", 90],
        ],
      },
    ]);
    await edit([
      {
        kind: "writeCells",
        sheet: "Pre-orders",
        topLeft: "A2",
        rows: [
          ["Web", "=SUMIFS(Historical!C:C,Historical!A:A,A2)", "10%", "=B2*(1+C2)"],
          ["Retail", "=SUMIFS(Historical!C:C,Historical!A:A,A3)", "5%", "=B3*(1+C3)"],
          ["Total", "=SUM(B2:B3)", null, "=SUM(D2:D3)"],
        ],
      },
      { kind: "formatCells", sheet: "Pre-orders", ranges: ["A4:D4"], format: { font: { bold: true } } },
    ]);

    const outline = await mcp.tool("read_sheet", { sheetId });
    expect(outline.body.tabs).toMatchObject([
      { name: "Historical", filledRange: "A1:C5", settings: { lastFrozenRow: 1 } },
      { name: "Pre-orders", filledRange: "A1:D4", settings: { lastFrozenRow: 1 } },
    ]);
    const read = await mcp.tool("read_cells", { sheetId, sheet: "Pre-orders", range: "A1:D4" });
    expect(read.body.revision).toBe(3);
    expect(read.body.rows).toEqual([
      ["Channel", "Orders last period", "Growth", "Forecast"],
      ["Web", { formula: "=SUMIFS(Historical!C:C,Historical!A:A,A2)", value: 260 }, { number: 0.1, shown: "10%" }, { formula: "=B2*(1+C2)", value: 286 }],
      ["Retail", { formula: "=SUMIFS(Historical!C:C,Historical!A:A,A3)", value: 170 }, { number: 0.05, shown: "5%" }, { formula: "=B3*(1+C3)", value: 178.5 }],
      ["Total", { formula: "=SUM(B2:B3)", value: 430 }, null, { formula: "=SUM(D2:D3)", value: 464.5 }],
    ]);

    // What the REST route serves (and the grid loads) agrees.
    const rest = await mcp.api.call("GET", `/api/sheets/${sheetId}`, { headers: { Cookie: mcp.cookie } });
    const { records } = (await rest.json()) as { records: Parameters<typeof workbookFromRecords>[0] };
    const workbook = workbookFromRecords(records);
    const header1 = workbook.sheets[1]!.cells.get(0)!;
    expect(header1.format).toMatchObject(header);
    expect(readCells(workbook, "Pre-orders", "D4")).toMatchObject({ rows: [[{ value: 464.5 }]] });
  });
});
