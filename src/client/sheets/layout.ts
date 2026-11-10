// Grid geometry: where each row and column starts, from the tab's sparse sizes,
// and which index sits under a pixel offset. Prefix sums, so a lookup is a
// binary search and a 1000 x 26 tab (or far bigger) lays out at once.

import type { CellFormat, Sheet } from "../../shared/sheet/types.ts";
import { DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT } from "../../shared/sheet/types.ts";
import type { Rect } from "./selection.ts";

export class Axis {
  private readonly offsets: Float64Array;
  readonly count: number;

  constructor(count: number, defaultSize: number, sizes: Readonly<Record<number, number>>) {
    this.count = count;
    this.offsets = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) {
      this.offsets[i + 1] = (this.offsets[i] as number) + (sizes[i] ?? defaultSize);
    }
  }

  /** Pixel offset where index `i` starts; `count` gives the total. */
  start(i: number): number {
    return this.offsets[Math.max(0, Math.min(this.count, i))] as number;
  }

  size(i: number): number {
    return this.start(i + 1) - this.start(i);
  }

  get total(): number {
    return this.offsets[this.count] as number;
  }

  /** The index under pixel `px`, clamped to the axis. */
  indexAt(px: number): number {
    if (px <= 0) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.offsets[mid] as number) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

export const rowAxis = (sheet: Sheet) => new Axis(sheet.rowCount, DEFAULT_ROW_HEIGHT, sheet.rowHeights);
export const columnAxis = (sheet: Sheet) =>
  new Axis(sheet.columnCount, DEFAULT_COLUMN_WIDTH, sheet.columnWidths);

/**
 * The last row and column holding anything (input or a format), or -1 each on
 * an empty tab. Formatting and clearing stay inside it, so a whole-column pick
 * never stores a cell for each of the tab's rows.
 */
export function storedExtent(sheet: Sheet): { readonly row: number; readonly col: number } {
  let row = -1;
  let col = -1;
  for (const key of sheet.cells.keys()) {
    const r = Math.floor(key / 32768);
    const c = key % 32768;
    if (r > row) row = r;
    if (c > col) col = c;
  }
  return { row, col };
}

/**
 * A selection made safe to format or clear: whole columns stop at the last
 * stored row (or the first 100 rows of an empty tab), whole rows at the last
 * stored column (at least the tab's first 26).
 */
export function boundedRect(rect: Rect, sheet: Sheet, kind: "cells" | "rows" | "columns"): Rect {
  const extent = storedExtent(sheet);
  let { r2, c2 } = rect;
  if (kind === "columns") r2 = Math.max(rect.r1, Math.min(r2, Math.max(extent.row, 99)));
  if (kind === "rows") c2 = Math.max(rect.c1, Math.min(c2, Math.max(extent.col, 25)));
  return { ...rect, r2, c2 };
}

/** Points to pixels: font sizes are points, as in Sheets. Default 10 pt. */
export const DEFAULT_FONT_POINTS = 10;
export const pointsToPx = (points: number) => Math.round((points * 4) / 3);

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Readable ink on a fill when the cell names no text colour (so dark mode keeps light fills legible). */
export function inkOn(fill: string): string {
  const l = luminance(fill);
  return l !== null && l < 0.18 ? "#f5f5f5" : "#1f1f1f";
}

/** Inline style for a cell's font and fill. */
export function cellStyle(format: CellFormat | undefined): Record<string, string | number> {
  const style: Record<string, string | number> = {};
  if (!format) return style;
  const font = format.font;
  if (format.fillColor) {
    style.background = format.fillColor;
    if (!font?.color) style.color = inkOn(format.fillColor);
  }
  if (font) {
    if (font.bold) style.fontWeight = 700;
    if (font.italic) style.fontStyle = "italic";
    const lines = [font.underline ? "underline" : "", font.strikethrough ? "line-through" : ""]
      .filter(Boolean)
      .join(" ");
    if (lines) style.textDecoration = lines;
    if (font.color) style.color = font.color;
    if (font.size) style.fontSize = `${pointsToPx(font.size)}px`;
  }
  return style;
}
