// Copy and paste as tab-separated text, the format Google Sheets and Excel put
// on the clipboard: a field holding a tab, newline or quote is quoted, and a
// quote inside it is doubled. Copying inside the grid also keeps the inputs, so
// pasting a formula shifts its relative references the way Sheets does.

import { rewriteFormula, offsetRelative } from "../../shared/sheet/formula/rewrite.ts";

/** Rows of fields from clipboard text. A trailing newline does not add a row. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const source = text.replace(/\r\n?/g, "\n");
  let atFieldStart = true;
  while (i < source.length) {
    const ch = source[i] as string;
    if (atFieldStart && ch === '"') {
      // A quoted field runs to the closing quote; "" is a quote inside it.
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < source.length) {
        if (source[j] === '"') {
          if (source[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += source[j];
        j += 1;
      }
      const next = source[j];
      if (closed && (next === undefined || next === "\t" || next === "\n")) {
        field = value;
        i = j;
        atFieldStart = false;
        continue;
      }
      // Not a well-formed quoted field: keep the quote as text.
    }
    if (ch === "\t") {
      row.push(field);
      field = "";
      atFieldStart = true;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
    }
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const quote = (field: string) =>
  /[\t\n\r"]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;

export function formatTsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((row) => row.map(quote).join("\t")).join("\n");
}

/** A formula as pasted `dRow` rows and `dCol` columns away; other input unchanged. */
export function shiftInput(input: string, dRow: number, dCol: number): string {
  if (!input.startsWith("=")) return input;
  return (
    rewriteFormula(input, (ref) => {
      const rows = offsetRelative(ref, "row", dRow);
      if (rows === "#REF!") return "#REF!";
      const cols = offsetRelative(rows ?? ref, "col", dCol);
      if (cols === "#REF!") return "#REF!";
      return cols ?? rows;
    }) ?? input
  );
}

/** What the last copy inside this page put on the clipboard. */
export interface GridClip {
  /** The text it wrote, to know the clipboard still holds it. */
  readonly text: string;
  /** Inputs as typed, by row. */
  readonly inputs: ReadonlyArray<ReadonlyArray<string>>;
  readonly sheetId: string;
  readonly row: number;
  readonly col: number;
  readonly cut: boolean;
}

/**
 * The inputs to write for a paste at (row, col): the grid's own copy with its
 * formulas shifted (moved as they are after a cut), or the clipboard text as typed.
 */
export function pasteInputs(
  text: string,
  clip: GridClip | null,
  at: { readonly row: number; readonly col: number },
): string[][] {
  const normalise = (value: string) => value.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (clip && normalise(clip.text) === normalise(text)) {
    const dRow = clip.cut ? 0 : at.row - clip.row;
    const dCol = clip.cut ? 0 : at.col - clip.col;
    return clip.inputs.map((row) => row.map((input) => shiftInput(input, dRow, dCol)));
  }
  return parseTsv(text);
}
