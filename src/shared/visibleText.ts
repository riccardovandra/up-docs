// The words a reader sees in a tab, for search and card previews: rich tables
// read as their headers and cells and diagrams as their labels, never as the
// JSON or code they are stored as. Worker only: diagrams load Babel's parser,
// which the client keeps out of its main bundle.

import { markdownToText } from "./anchors.ts";
import { cellText, findFences, parseTable, TABLE_LANGUAGE } from "./table.ts";
import { WIDGET_LANGUAGE } from "./widget/fence.ts";
import { analyzeWidget } from "./widget/validate.ts";

/** A rich table's or diagram's visible lines; null for any other fenced block. */
export function richBlockText(language: string, body: string): ReadonlyArray<string> | null {
  if (language === TABLE_LANGUAGE) {
    const parsed = parseTable(body);
    if (!parsed.ok) return [];
    const { columns, rows } = parsed.table;
    return [
      ...columns.map((column) => column.name),
      ...rows.flatMap((row) => columns.map((column) => cellText(row.cells[column.id]))),
    ].filter((text) => text.trim() !== "");
  }
  if (language === WIDGET_LANGUAGE) return analyzeWidget(body).labels.map((label) => label.text);
  return null;
}

/** A tab's visible text, one block per line; code blocks keep their code. */
export function visibleText(markdown: string): string {
  const parts: Array<string> = [];
  let at = 0;
  for (const fence of findFences(markdown)) {
    parts.push(markdownToText(markdown.slice(at, fence.start)));
    parts.push(...(richBlockText(fence.language, fence.body) ?? [fence.body]));
    at = fence.end;
  }
  parts.push(markdownToText(markdown.slice(at)));
  return parts.filter((part) => part.trim() !== "").join("\n");
}
