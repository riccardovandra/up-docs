import { describe, expect, it } from "vitest";

import {
  changeColumnType,
  checkTablesIn,
  findFences,
  formatTable,
  parseTable,
  replaceTable,
  richTablesToGfm,
  findTables,
  type RichTable,
} from "./table.ts";

const TABLE: RichTable = {
  id: "t1",
  columns: [
    { id: "name", name: "Request", type: "text" },
    {
      id: "status",
      name: "Status",
      type: "select",
      options: [{ value: "Not started", color: "gray" }],
    },
    { id: "ticket", name: "Tickets", type: "link" },
    { id: "n", name: "#", type: "number" },
  ],
  rows: [
    {
      id: "r1",
      cells: {
        name: "Fix a | b\nnow",
        status: "Not started",
        ticket: { text: "TASK-1", url: "https://x.test/a b" },
        n: 1,
      },
    },
    { id: "r2", cells: {} },
  ],
};

const errorOf = (value: unknown) => {
  const parsed = parseTable(JSON.stringify(value));
  return parsed.ok ? null : parsed.error;
};

describe("parseTable", () => {
  it("accepts its own format and reads back what it wrote", () => {
    const parsed = parseTable(formatTable(TABLE));
    expect(parsed).toEqual({ ok: true, table: TABLE });
  });

  it.each([
    [{ ...TABLE, id: "has space" }, 'The table needs an "id"'],
    [{ ...TABLE, columns: [] }, '"columns" must be a non-empty array'],
    [{ ...TABLE, columns: [TABLE.columns[0], TABLE.columns[0]] }, 'Column id "name" is repeated'],
    [{ ...TABLE, rows: [TABLE.rows[1], TABLE.rows[1]] }, 'Row id "r2" is repeated'],
    [{ ...TABLE, rows: [{ id: "r", cells: { n: "one" } }] }, "rows[0].cells.n"],
    [
      { ...TABLE, rows: [{ id: "r", cells: { owner: "me" } }] },
      '"owner", which is not a column id',
    ],
    [
      {
        ...TABLE,
        rows: [{ id: "r", cells: { ticket: { text: "x", url: "javascript:alert(1)" } } }],
      },
      "http(s) or mailto",
    ],
    [{ ...TABLE, columns: [{ id: "a", name: "A", type: "text", options: [] }] }, "only select"],
  ])("explains what is wrong (%#)", (value, message) => {
    expect(errorOf(value)).toContain(message);
  });

  it("reports bad JSON", () => {
    expect(parseTable("{nope")).toMatchObject({
      ok: false,
      error: expect.stringContaining("JSON"),
    });
  });
});

describe("fences", () => {
  it("finds fences and their bodies, including a longer closing fence and EOF", () => {
    const markdown = "a\n```t3-table\n{}\n````\nb\n~~~js\nx\n";
    expect(findFences(markdown).map(({ language, body }) => ({ language, body }))).toEqual([
      { language: "t3-table", body: "{}" },
      { language: "js", body: "x\n" },
    ]);
  });

  it("rewrites only the table body", () => {
    const markdown = 'Intro\n\n```t3-table\n{"id":"old"}\n```\n\nOutro';
    const [block] = findTables(markdown);
    const next = replaceTable(markdown, block!, TABLE);
    expect(next).toBe(`Intro\n\n\`\`\`t3-table\n${formatTable(TABLE)}\n\`\`\`\n\nOutro`);
    const [empty] = findTables("```t3-table\n```");
    expect(replaceTable("```t3-table\n```", empty!, TABLE)).toBe(
      `\`\`\`t3-table\n${formatTable(TABLE)}\n\`\`\``,
    );
  });

  it("requires every table in a tab to parse, with unique ids", () => {
    const fence = (table: RichTable) => `\`\`\`t3-table\n${formatTable(table)}\n\`\`\``;
    expect(checkTablesIn(`${fence(TABLE)}\n\n${fence({ ...TABLE, id: "t2" })}`)).toBeNull();
    expect(checkTablesIn(`${fence(TABLE)}\n\n${fence(TABLE)}`)).toContain('"t1" is repeated');
    expect(checkTablesIn("```t3-table\n[]\n```")).toContain("must be a JSON object");
  });
});

describe("richTablesToGfm", () => {
  it("renders tables as GFM, escaping pipes and newlines, and keeps invalid ones", () => {
    const markdown = `# T\n\n\`\`\`t3-table\n${formatTable(TABLE)}\n\`\`\`\n\n\`\`\`t3-table\nbad\n\`\`\``;
    expect(richTablesToGfm(markdown)).toBe(
      [
        "# T",
        "",
        "| Request | Status | Tickets | # |",
        "| --- | --- | --- | --- |",
        "| Fix a \\| b<br>now | Not started | [TASK-1](https://x.test/a%20b) | 1 |",
        "|  |  |  |  |",
        "",
        "```t3-table\nbad\n```",
      ].join("\n"),
    );
  });
});

describe("changeColumnType", () => {
  it("makes a select column with one option per distinct value", () => {
    const table: RichTable = {
      id: "t",
      columns: [{ id: "a", name: "A", type: "text" }],
      rows: [
        { id: "1", cells: { a: "High" } },
        { id: "2", cells: { a: "Low" } },
        { id: "3", cells: { a: "High" } },
      ],
    };
    const select = changeColumnType(table, "a", "select");
    expect(select.columns[0]!.options?.map((option) => option.value)).toEqual(["High", "Low"]);
    expect(parseTable(formatTable(select)).ok).toBe(true);
    const number = changeColumnType(table, "a", "number");
    expect(number.rows.every((row) => !("a" in row.cells))).toBe(true);
  });
});
