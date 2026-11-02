export interface Span {
  readonly left: number;
  readonly right: number;
}

export interface Band {
  readonly top: number;
  readonly bottom: number;
}

export interface Breakout {
  /** Added to the table's left edge; zero or negative. */
  readonly offset: number;
  readonly width: number;
}

export const overlaps = (a: Band, b: Band) =>
  a.top < b.bottom && b.top < a.bottom;

/**
 * How far a table leaves the text column. A table that fits stays in the
 * column. A wider one takes the page width, stopping at the column's right
 * edge when a comment sits beside it so the card stays readable.
 */
export function breakoutFor(input: {
  readonly required: number;
  readonly column: Span;
  readonly page: Span;
  readonly commentBeside: boolean;
}): Breakout | null {
  const { required, column, page, commentBeside } = input;
  if (required <= column.right - column.left) return null;
  const left = Math.min(page.left, column.left);
  const right = commentBeside
    ? column.right
    : Math.max(page.right, column.right);
  if (left === column.left && right === column.right) return null;
  return { offset: left - column.left, width: right - left };
}
