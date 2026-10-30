// Rich tables: a ```t3-table fenced block whose body is JSON. The fence keeps
// tabs plain markdown for agents, and the ids give comments something stable
// to anchor to while rows and columns are edited, reordered or removed.

export const TABLE_LANGUAGE = "t3-table";

export const COLUMN_TYPES = ["text", "select", "link", "number", "date"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const CHIP_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
] as const;
export type ChipColor = (typeof CHIP_COLORS)[number];

export interface SelectOption {
  readonly value: string;
  readonly color: ChipColor;
}

export interface TableColumn {
  readonly id: string;
  readonly name: string;
  readonly type: ColumnType;
  /** Select columns only. */
  readonly options?: ReadonlyArray<SelectOption>;
}

export interface LinkValue {
  readonly text: string;
  readonly url: string;
}

/** text, select and date cells hold strings; number cells numbers; link cells `{text,url}`. */
export type CellValue = string | number | LinkValue | null;

export interface TableRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, CellValue>>;
}

export interface RichTable {
  readonly id: string;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly rows: ReadonlyArray<TableRow>;
}

export const MAX_TABLE_COLUMNS = 50;
export const MAX_TABLE_ROWS = 5_000;
export const MAX_CELL_LENGTH = 10_000;
const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class TableError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkId(value: unknown, where: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || value.length > MAX_ID_LENGTH) {
    throw new TableError(
      `${where} needs an "id": letters, digits, "_" or "-", up to ${MAX_ID_LENGTH} characters.`,
    );
  }
  return value;
}

/** Links render as anchors, so only schemes that cannot run script are allowed. */
export const isSafeUrl = (url: string) => url === "" || /^(https?:|mailto:)/i.test(url);

/** Checks one cell value against its column, returning it in canonical form. */
export function checkCell(column: TableColumn, value: unknown, where: string): CellValue {
  if (value === null || value === undefined) return null;
  const label = `${where} (column "${column.id}", ${column.type})`;
  switch (column.type) {
    case "text":
      if (typeof value !== "string") throw new TableError(`${label} must be a string.`);
      if (value.length > MAX_CELL_LENGTH) throw new TableError(`${label} is too long.`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TableError(`${label} must be a finite number.`);
      }
      return value;
    case "date":
      if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
        throw new TableError(`${label} must be a "YYYY-MM-DD" string.`);
      }
      return value;
    case "select": {
      if (typeof value !== "string") throw new TableError(`${label} must be a string.`);
      if (value === "") return null;
      const options = column.options ?? [];
      if (!options.some((option) => option.value === value)) {
        const allowed = options.map((option) => JSON.stringify(option.value)).join(", ");
        throw new TableError(
          `${label} is ${JSON.stringify(value)}, which is not one of its options (${allowed || "none"}). Add it to the column's "options" first.`,
        );
      }
      return value;
    }
    case "link": {
      if (!isRecord(value) || typeof value.text !== "string" || typeof value.url !== "string") {
        throw new TableError(`${label} must be {"text": string, "url": string}.`);
      }
      if (value.text.length > MAX_CELL_LENGTH || value.url.length > MAX_CELL_LENGTH) {
        throw new TableError(`${label} is too long.`);
      }
      if (!isSafeUrl(value.url)) {
        throw new TableError(`${label} needs an http(s) or mailto url.`);
      }
      return { text: value.text, url: value.url };
    }
  }
}

function checkColumn(value: unknown, index: number): TableColumn {
  const where = `columns[${index}]`;
  if (!isRecord(value)) throw new TableError(`${where} must be an object.`);
  const id = checkId(value.id, where);
  if (typeof value.name !== "string" || value.name.length > 200) {
    throw new TableError(`${where} needs a "name" string.`);
  }
  if (!COLUMN_TYPES.includes(value.type as ColumnType)) {
    throw new TableError(`${where} "type" must be one of ${COLUMN_TYPES.join(", ")}.`);
  }
  const type = value.type as ColumnType;
  if (type !== "select") {
    if (value.options !== undefined) {
      throw new TableError(`${where} has "options" but only select columns take them.`);
    }
    return { id, name: value.name, type };
  }
  const rawOptions = value.options ?? [];
  if (!Array.isArray(rawOptions)) throw new TableError(`${where} "options" must be an array.`);
  const seen = new Set<string>();
  const options = rawOptions.map((option, optionIndex): SelectOption => {
    const at = `${where}.options[${optionIndex}]`;
    if (!isRecord(option) || typeof option.value !== "string" || option.value === "") {
      throw new TableError(`${at} needs a non-empty "value" string.`);
    }
    if (seen.has(option.value)) {
      throw new TableError(`${at} repeats the value ${JSON.stringify(option.value)}.`);
    }
    seen.add(option.value);
    const color = option.color ?? "gray";
    if (!CHIP_COLORS.includes(color as ChipColor)) {
      throw new TableError(`${at} "color" must be one of ${CHIP_COLORS.join(", ")}.`);
    }
    return { value: option.value, color: color as ChipColor };
  });
  return { id, name: value.name, type, options };
}

/** Validates a parsed table, returning it in canonical form or throwing a `TableError`. */
export function checkTable(value: unknown): RichTable {
  if (!isRecord(value)) throw new TableError("A t3-table body must be a JSON object.");
  const id = checkId(value.id, "The table");
  if (!Array.isArray(value.columns) || value.columns.length === 0) {
    throw new TableError('"columns" must be a non-empty array.');
  }
  if (value.columns.length > MAX_TABLE_COLUMNS) {
    throw new TableError(`A table can have at most ${MAX_TABLE_COLUMNS} columns.`);
  }
  const columns = value.columns.map(checkColumn);
  const columnIds = new Set<string>();
  for (const column of columns) {
    if (columnIds.has(column.id)) throw new TableError(`Column id "${column.id}" is repeated.`);
    columnIds.add(column.id);
  }
  const rawRows = value.rows ?? [];
  if (!Array.isArray(rawRows)) throw new TableError('"rows" must be an array.');
  if (rawRows.length > MAX_TABLE_ROWS) {
    throw new TableError(`A table can have at most ${MAX_TABLE_ROWS} rows.`);
  }
  const rowIds = new Set<string>();
  const rows = rawRows.map((row, index): TableRow => {
    const where = `rows[${index}]`;
    if (!isRecord(row)) throw new TableError(`${where} must be an object.`);
    const rowId = checkId(row.id, where);
    if (rowIds.has(rowId)) throw new TableError(`Row id "${rowId}" is repeated.`);
    rowIds.add(rowId);
    const rawCells = row.cells ?? {};
    if (!isRecord(rawCells)) throw new TableError(`${where} "cells" must be an object.`);
    return { id: rowId, cells: checkCells(columns, rawCells, `${where}.cells`) };
  });
  return { id, columns, rows };
}

/** Checks a cells object keyed by column id. Empty cells are dropped. */
export function checkCells(
  columns: ReadonlyArray<TableColumn>,
  cells: Record<string, unknown>,
  where: string,
): Record<string, CellValue> {
  const checked: Record<string, CellValue> = {};
  for (const [columnId, raw] of Object.entries(cells)) {
    const column = columns.find((candidate) => candidate.id === columnId);
    if (!column) {
      const known = columns.map((candidate) => `"${candidate.id}"`).join(", ");
      throw new TableError(`${where} has "${columnId}", which is not a column id (${known}).`);
    }
    const value = checkCell(column, raw, `${where}.${columnId}`);
    if (value !== null) checked[columnId] = value;
  }
  return checked;
}

export type TableParse =
  | { readonly ok: true; readonly table: RichTable }
  | { readonly ok: false; readonly error: string };

export function parseTable(source: string): TableParse {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "invalid JSON";
    return { ok: false, error: `The t3-table body is not valid JSON: ${detail}` };
  }
  try {
    return { ok: true, table: checkTable(value) };
  } catch (cause) {
    if (cause instanceof TableError) return { ok: false, error: cause.message };
    throw cause;
  }
}

/**
 * The fence body for a table: one line per column and per row, so diffs and
 * agent `edit_tab` finds stay small. JSON escapes newlines, so no line can
 * close the fence.
 */
export function formatTable(table: RichTable): string {
  const columns = table.columns.map((column) => `    ${JSON.stringify(column)}`);
  const rows = table.rows.map((row) => `    ${JSON.stringify({ id: row.id, cells: row.cells })}`);
  const list = (items: Array<string>) =>
    items.length === 0 ? "[]" : `[\n${items.join(",\n")}\n  ]`;
  return `{\n  "id": ${JSON.stringify(table.id)},\n  "columns": ${list(columns)},\n  "rows": ${list(rows)}\n}`;
}

/** A fenced code block in a tab's markdown; `body` is `markdown.slice(bodyStart, bodyEnd)`. */
export interface Fence {
  readonly language: string;
  readonly info: string;
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly body: string;
}

/**
 * The fenced blocks in `markdown`, by CommonMark's rules for the cases agents
 * and the editor write: up to three spaces of indent, a closing fence of the
 * same character at least as long, or the end of the document.
 */
export function findFences(markdown: string): ReadonlyArray<Fence> {
  const fences: Array<Fence> = [];
  const lineEnd = (at: number) => {
    const next = markdown.indexOf("\n", at);
    return next === -1 ? markdown.length : next;
  };
  let open: { marker: string; info: string; start: number; bodyStart: number } | null = null;
  for (let at = 0; at <= markdown.length;) {
    const end = lineEnd(at);
    const line = markdown.slice(at, end).replace(/\r$/, "");
    if (open === null) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
        open = { marker: match[1]!, info: match[2]!.trim(), start: at, bodyStart: end + 1 };
      }
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === open.marker[0] && close[1]!.length >= open.marker.length) {
        const bodyStart = Math.min(open.bodyStart, at);
        const bodyEnd = Math.max(bodyStart, at - 1);
        fences.push({
          language: open.info.split(/\s+/, 1)[0] ?? "",
          info: open.info,
          start: open.start,
          end,
          bodyStart,
          bodyEnd,
          body: markdown.slice(bodyStart, bodyEnd),
        });
        open = null;
      }
    }
    at = end + 1;
  }
  if (open !== null) {
    const bodyStart = Math.min(open.bodyStart, markdown.length);
    fences.push({
      language: open.info.split(/\s+/, 1)[0] ?? "",
      info: open.info,
      start: open.start,
      end: markdown.length,
      bodyStart,
      bodyEnd: markdown.length,
      body: markdown.slice(bodyStart),
    });
  }
  return fences;
}

export interface TableBlock {
  readonly fence: Fence;
  readonly parsed: TableParse;
}

export const findTables = (markdown: string): ReadonlyArray<TableBlock> =>
  findFences(markdown)
    .filter((fence) => fence.language === TABLE_LANGUAGE)
    .map((fence) => ({ fence, parsed: parseTable(fence.body) }));

/**
 * Every table a write adds or changes must parse, with an id unique in the
 * tab. A table left byte-identical to `previous` is not re-checked, so older
 * content never blocks an unrelated edit.
 */
export function checkTablesIn(markdown: string, previous?: string): string | null {
  const unchanged = new Set(
    previous === undefined ? [] : findTables(previous).map(({ fence }) => fence.body),
  );
  const ids = new Set<string>();
  const tables = findTables(markdown);
  for (const [index, { fence, parsed }] of tables.entries()) {
    // An empty block is a table being started in the editor.
    const checked = fence.body.trim() !== "" && !unchanged.has(fence.body);
    const which = tables.length === 1 ? "The t3-table block" : `t3-table block ${index + 1}`;
    if (!parsed.ok) {
      if (checked) return `${which}: ${parsed.error}`;
      continue;
    }
    if (checked && ids.has(parsed.table.id)) {
      return `${which}: table id "${parsed.table.id}" is repeated.`;
    }
    ids.add(parsed.table.id);
  }
  return null;
}

/** Replaces one table's fence body; the fence lines themselves are left as written. */
export function replaceTable(markdown: string, block: TableBlock, table: RichTable): string {
  const { bodyStart, bodyEnd } = block.fence;
  // An empty fence has no body line between its fence lines; give the JSON one.
  const lead = markdown[bodyStart - 1] === "\n" ? "" : "\n";
  const trail = bodyEnd < markdown.length && markdown[bodyEnd] !== "\n" ? "\n" : "";
  return markdown.slice(0, bodyStart) + lead + formatTable(table) + trail + markdown.slice(bodyEnd);
}

/** How a cell reads as text: chips by value, links by their text. */
export function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return value.text || value.url;
  return String(value);
}

const gfmCell = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

function gfmValue(value: CellValue | undefined): string {
  if (value !== null && typeof value === "object") {
    const text = gfmCell(value.text || value.url).replace(/[[\]]/g, "\\$&");
    return value.url ? `[${text}](${value.url.replace(/[()\s]/g, encodeURIComponent)})` : text;
  }
  return gfmCell(cellText(value));
}

export function tableToGfm(table: RichTable): string {
  const header = table.columns.map((column) => gfmCell(column.name) || " ");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${table.columns.map(() => "---").join(" | ")} |`,
    ...table.rows.map(
      (row) => `| ${table.columns.map((column) => gfmValue(row.cells[column.id])).join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

/** The markdown with every valid t3-table fence rendered as a GFM table, for downloads. */
export function richTablesToGfm(markdown: string): string {
  let result = "";
  let at = 0;
  for (const { fence, parsed } of findTables(markdown)) {
    if (!parsed.ok) continue;
    result += markdown.slice(at, fence.start) + tableToGfm(parsed.table);
    at = fence.end;
  }
  return result + markdown.slice(at);
}

let idCounter = 0;
/** A short id for new rows, columns and tables. */
export function newTableId(prefix: string): string {
  idCounter = (idCounter + 1) % 1296;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}${random}${idCounter.toString(36)}`;
}

/** The table a new ```t3-table block starts as. */
export function starterTable(): RichTable {
  const name = newTableId("c");
  const status = newTableId("c");
  return {
    id: newTableId("t"),
    columns: [
      { id: name, name: "Name", type: "text" },
      {
        id: status,
        name: "Status",
        type: "select",
        options: [
          { value: "Not started", color: "gray" },
          { value: "In progress", color: "blue" },
          { value: "Done", color: "green" },
        ],
      },
    ],
    rows: [{ id: newTableId("r"), cells: { [status]: "Not started" } }],
  };
}

/** Converts a value when its column changes type, keeping what still makes sense. */
export function convertCell(value: CellValue | undefined, to: TableColumn): CellValue {
  const text = cellText(value);
  if (text === "") return null;
  switch (to.type) {
    case "text":
      return text;
    case "number": {
      const number = Number(text.replace(/,/g, ""));
      return Number.isFinite(number) ? number : null;
    }
    case "date":
      return DATE_PATTERN.test(text) ? text : null;
    case "select":
      return to.options?.some((option) => option.value === text) ? text : null;
    case "link":
      if (value !== null && typeof value === "object") return value;
      return isSafeUrl(text) && /^https?:/i.test(text) ? { text, url: text } : { text, url: "" };
  }
}

/** Changes a column's type, converting its cells. A new select column gets an option per distinct value. */
export function changeColumnType(table: RichTable, columnId: string, type: ColumnType): RichTable {
  const current = table.columns.find((column) => column.id === columnId);
  if (!current || current.type === type) return table;
  let next: TableColumn = { id: current.id, name: current.name, type };
  if (type === "select") {
    const values = [
      ...new Set(table.rows.map((row) => cellText(row.cells[columnId])).filter(Boolean)),
    ];
    next = {
      ...next,
      options: values.map((value, index) => ({
        value,
        color: CHIP_COLORS[index % CHIP_COLORS.length]!,
      })),
    };
  }
  return {
    ...table,
    columns: table.columns.map((column) => (column.id === columnId ? next : column)),
    rows: table.rows.map((row) => withCell(row, columnId, convertCell(row.cells[columnId], next))),
  };
}

export function withCell(row: TableRow, columnId: string, value: CellValue): TableRow {
  const cells = { ...row.cells };
  if (value === null || cellText(value) === "") delete cells[columnId];
  else cells[columnId] = value;
  return { id: row.id, cells };
}
