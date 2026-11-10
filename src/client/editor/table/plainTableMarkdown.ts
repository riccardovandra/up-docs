import { Extension, type JSONContent } from "@tiptap/core";
import { Table, renderTableToMarkdown } from "@tiptap/extension-table";

/**
 * Column widths of a plain markdown table, kept in an HTML comment on the line
 * above it: `<!-- col-widths: 120 240 0 -->`. Markdown has no place for widths;
 * a comment is invisible in every renderer and survives a plain-text edit.
 * A 0 means the column has no set width.
 */
const WIDTHS_LINE = /^<!--[ \t]*col-widths:[ \t]*([\d \t]*?)[ \t]*-->[ \t]*\n/;
const TABLE_SEPARATOR = /^[ \t|:]*-[ \t|:-]*$/;

export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 2000;

export type ColumnWidths = ReadonlyArray<number | null>;

const columnWidth = (value: unknown): number | null => {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
};

export const parseColumnWidths = (text: string): ColumnWidths =>
  text.trim() === "" ? [] : text.trim().split(/\s+/).map(columnWidth);

/** The comment line for these widths, or null when no column has one. */
export const formatColumnWidths = (widths: ColumnWidths): string | null =>
  widths.some((width) => width !== null)
    ? `<!-- col-widths: ${widths.map((width) => width ?? 0).join(" ")} -->`
    : null;

/** Widths from the first row; resizing a column sets the same width on every cell in it. */
const widthsOf = (table: JSONContent): ColumnWidths =>
  (table.content?.[0]?.content ?? []).map((cell) => {
    const colwidth = cell.attrs?.colwidth as unknown;
    return Array.isArray(colwidth) ? columnWidth(colwidth[0]) : null;
  });

const withWidths = (table: JSONContent, widths: ColumnWidths): JSONContent => ({
  ...table,
  content: (table.content ?? []).map((row) => ({
    ...row,
    content: (row.content ?? []).map((cell, index) => {
      const width = widths[index] ?? null;
      return width === null ? cell : { ...cell, attrs: { ...cell.attrs, colwidth: [width] } };
    }),
  })),
});

/** The stock table, written with its widths comment when a column has been resized. */
export const DocTable = Table.extend({
  renderMarkdown(node, helpers) {
    const table = renderTableToMarkdown(node, helpers);
    const line = formatColumnWidths(widthsOf(node));
    return line ? `\n${line}${table.startsWith("\n") ? "" : "\n"}${table}` : table;
  },
});

interface WidthsToken {
  type: "tableWidths";
  raw: string;
  widths: ColumnWidths;
  tokens: unknown[];
}

/** Reads a widths comment together with the table under it. */
export const TableWidths = Extension.create({
  name: "tableWidths",
  markdownTokenName: "tableWidths",
  markdownTokenizer: {
    name: "tableWidths",
    level: "block",
    start: (src: string) => {
      const match = /(^|\n)<!--[ \t]*col-widths:/.exec(src);
      return match ? match.index + match[1]!.length : -1;
    },
    tokenize(src, _tokens, helper) {
      const line = WIDTHS_LINE.exec(src);
      if (!line) return undefined;
      const rest = src.slice(line[0].length);
      const blank = rest.search(/\n[ \t]*\n/);
      const candidate = blank >= 0 ? rest.slice(0, blank) : rest;
      const lines = candidate.split("\n");
      // Only lex a real table; lexing anything else here would disturb the outer lexer.
      if (lines.length < 2 || !lines[0]!.includes("|")) return undefined;
      if (!TABLE_SEPARATOR.test(lines[1]!) || !lines[1]!.includes("|")) return undefined;
      const table = helper.blockTokens(candidate)[0];
      if (!table || table.type !== "table") return undefined;
      return {
        type: "tableWidths",
        raw: line[0] + table.raw,
        widths: parseColumnWidths(line[1] ?? ""),
        tokens: [table],
      };
    },
  },
  parseMarkdown: (token, helpers) => {
    const { widths, tokens } = token as unknown as WidthsToken;
    const nodes = helpers.parseChildren(tokens as never) as JSONContent[];
    return nodes.map((node) => (node.type === "table" ? withWidths(node, widths) : node));
  },
});
