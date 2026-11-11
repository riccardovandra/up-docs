// Layout checks for a Draw.io page, from geometry alone: labels that do not fit
// their box, boxes that overlap or stick out of the container they sit in, and
// connections that run through a box that is neither of their ends. Draw.io's
// orthogonal router avoids only a line's own two ends, so an agent never sees
// these until a person opens the picture. Every check leans towards silence:
// text widths are estimates, and a line is reported only when every route
// Draw.io could plausibly take runs through the same box.

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface LayoutBox {
  readonly id: string;
  /** The label's first line, for messages; "" when it has none. */
  readonly name: string;
  /** Absolute position on the page. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The id of the shape it sits in, when that is a shape. */
  readonly parent: string | undefined;
  /**
   * "container": a swimlane, group or `container=1` shape, drawn behind what it holds.
   * "text": words without a box. "box": anything else with a frame.
   */
  readonly kind: "box" | "container" | "text";
  /** The label's lines as drawn (one per line break), in plain words. */
  readonly lines: ReadonlyArray<string>;
  readonly fontSize: number;
  /** `fontFamily`, or "" for Draw.io's default (Helvetica). */
  readonly fontFamily: string;
  readonly bold: boolean;
  /** Whether the label wraps at the box's width (`whiteSpace=wrap` on an HTML label). */
  readonly wrap: boolean;
  /** Room taken from each side before the text starts. */
  readonly padding: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  /** Whether the label is drawn inside the box, so it can overflow it. */
  readonly labelInside: boolean;
  /** A swimlane's header height; the label lives there. 0 for anything else. */
  readonly header: number;
}

export interface LayoutEdge {
  readonly id: string;
  readonly source: string | undefined;
  readonly target: string | undefined;
  /** Where a loose end sits, absolute. */
  readonly sourcePoint: LayoutPoint | undefined;
  readonly targetPoint: LayoutPoint | undefined;
  /** `exitX`/`exitY` and `entryX`/`entryY`: where on its box each end attaches, 0 to 1. */
  readonly exit: LayoutPoint | undefined;
  readonly entry: LayoutPoint | undefined;
  /** Bend points, absolute. */
  readonly points: ReadonlyArray<LayoutPoint>;
  /** False for a straight line (`edgeStyle=none` or none named). */
  readonly orthogonal: boolean;
}

/**
 * Average glyph width, spaces included, as a share of the font size: measured
 * on English sentences. Helvetica and Arial are narrow; other web fonts (Inter,
 * Montserrat) run wider. Bold adds a little.
 */
const NARROW_FONTS = /^(?:helvetica|arial|liberation sans|sans-serif)?$/i;
const NARROW_CHAR_WIDTH = 0.5;
const WIDE_CHAR_WIDTH = 0.56;
const BOLD_EXTRA = 0.05;
const LINE_HEIGHT = 1.2;
/** Pixels of overflow tolerated before a label is reported: the width is an estimate. */
const TEXT_SLACK = 4;
/** How far boxes may touch before they count as overlapping. */
const TOUCH = 2;
/** Boxes are shrunk by this much before a line through them counts. */
const LINE_SLACK = 3;
const MAX_LAYOUT_WARNINGS = 8;

const charWidth = (box: LayoutBox) =>
  box.fontSize *
  ((NARROW_FONTS.test(box.fontFamily.trim()) ? NARROW_CHAR_WIDTH : WIDE_CHAR_WIDTH) +
    (box.bold ? BOLD_EXTRA : 0));
const textWidth = (box: LayoutBox, text: string) => text.length * charWidth(box);

const named = (box: LayoutBox) => `"${box.name || box.id}"`;

/** How many lines `line` takes when wrapped at `width`, and its longest word's width. */
function wrapLine(box: LayoutBox, line: string, width: number): { lines: number; widest: number } {
  const words = line.split(" ").filter((word) => word !== "");
  const space = charWidth(box);
  let lines = 1;
  let used = 0;
  let widest = 0;
  for (const word of words) {
    const w = textWidth(box, word);
    widest = Math.max(widest, w);
    if (used === 0) used = w;
    else if (used + space + w <= width) used += space + w;
    else {
      lines += 1;
      used = w;
    }
  }
  return { lines, widest };
}

/** What a label needs, in px, against what its box gives it; null when it fits. */
function textOverflow(box: LayoutBox): string | null {
  if (!box.labelInside || box.lines.length === 0 || box.kind === "text") return null;
  const room = {
    width: box.width - box.padding.left - box.padding.right,
    height: (box.header > 0 ? box.header : box.height) - box.padding.top - box.padding.bottom,
  };
  if (room.width <= 0 || room.height <= 0) return null;
  const lineHeight = box.fontSize * LINE_HEIGHT;
  let width = 0;
  let lines = 0;
  for (const line of box.lines) {
    if (box.wrap) {
      const wrapped = wrapLine(box, line, room.width);
      lines += wrapped.lines;
      width = Math.max(width, wrapped.widest);
    } else {
      lines += 1;
      width = Math.max(width, textWidth(box, line));
    }
  }
  // A container's label is its header: only its width matters.
  const height = box.header > 0 ? 0 : lines * lineHeight;
  const wide = width > room.width + TEXT_SLACK;
  const tall = height > room.height + TEXT_SLACK;
  if (!wide && !tall) return null;
  const needW = Math.ceil(Math.max(width, room.width) + box.padding.left + box.padding.right);
  const needH = Math.ceil(Math.max(height, room.height) + box.padding.top + box.padding.bottom);
  const fix = wide && !box.wrap
    ? "Add whiteSpace=wrap;html=1; to its style and make it taller, widen it, or shorten the text."
    : "Widen or heighten the box, or shorten the text.";
  return (
    `${named(box)}: the text runs outside its box. It needs about ${needW} x ${needH} px; ` +
    `the box is ${Math.round(box.width)} x ${Math.round(box.height)}. ${fix}`
  );
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const inside = (inner: Rect, outer: Rect, slack = 1) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

const overlaps = (a: Rect, b: Rect, by = TOUCH) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > by &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > by;

const shrink = (r: Rect, by: number): Rect => ({
  x: r.x + by,
  y: r.y + by,
  width: Math.max(0, r.width - 2 * by),
  height: Math.max(0, r.height - 2 * by),
});

/** Whether the segment a-b passes through the inside of `r` (Liang-Barsky clipping). */
function segmentHits(a: LayoutPoint, b: LayoutPoint, r: Rect): boolean {
  if (r.width <= 0 || r.height <= 0) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: ReadonlyArray<[number, number]> = [
    [-dx, a.x - r.x],
    [dx, r.x + r.width - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.height - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return t1 - t0 > 1e-6;
}

const centre = (r: Rect): LayoutPoint => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Joins two points with right angles, turning once: horizontal first or vertical first. */
function elbow(a: LayoutPoint, b: LayoutPoint, horizontalFirst: boolean): Array<LayoutPoint> {
  if (a.x === b.x || a.y === b.y) return [b];
  return horizontalFirst ? [{ x: b.x, y: a.y }, b] : [{ x: a.x, y: b.y }, b];
}

/** The routes Draw.io could plausibly draw for an edge, each a polyline from its source to its target. */
function candidateRoutes(
  edge: LayoutEdge,
  from: Rect | undefined,
  to: Rect | undefined,
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  const anchor = (box: Rect | undefined, at: LayoutPoint | undefined, loose: LayoutPoint | undefined) =>
    box ? (at ? { x: box.x + at.x * box.width, y: box.y + at.y * box.height } : centre(box)) : loose;
  const start = anchor(from, edge.exit, edge.sourcePoint);
  const end = anchor(to, edge.entry, edge.targetPoint);
  if (!start || !end) return [];
  const stops = [...edge.points, end];
  if (!edge.orthogonal) {
    return [[start, ...stops]];
  }
  if (edge.points.length > 0) {
    return [true, false].map((horizontalFirst) => {
      const route = [start];
      for (const stop of stops) route.push(...elbow(route[route.length - 1]!, stop, horizontalFirst));
      return route;
    });
  }
  // No bend points: a straight run where the two boxes face each other, else one of the Z shapes.
  if (from && to && !edge.exit && !edge.entry) {
    const top = Math.max(from.y, to.y);
    const bottom = Math.min(from.y + from.height, to.y + to.height);
    if (bottom - top > 0) {
      const y = (top + bottom) / 2;
      return [[{ x: start.x, y }, { x: end.x, y }]];
    }
    const left = Math.max(from.x, to.x);
    const right = Math.min(from.x + from.width, to.x + to.width);
    if (right - left > 0) {
      const x = (left + right) / 2;
      return [[{ x, y: start.y }, { x, y: end.y }]];
    }
  }
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  return [
    [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end],
    [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end],
    [start, ...elbow(start, end, true)],
    [start, ...elbow(start, end, false)],
  ];
}

/**
 * The layout problems on one page, as sentences an agent can act on; at most
 * MAX_LAYOUT_WARNINGS, then one line counting the rest.
 */
export function layoutProblems(
  boxes: ReadonlyArray<LayoutBox>,
  edges: ReadonlyArray<LayoutEdge>,
): ReadonlyArray<string> {
  const usable = boxes.filter((box) => box.width > 0 && box.height > 0);
  const byId = new Map(usable.map((box) => [box.id, box]));
  const parents = new Set(usable.flatMap((box) => (box.parent ? [box.parent] : [])));
  // Background shapes: containers by style or structure, and any box drawn around other boxes.
  // They frame the boxes that matter, so lines may cross them and boxes may sit on them.
  const background = new Set(
    usable
      .filter(
        (box) =>
          box.kind === "container" ||
          parents.has(box.id) ||
          usable.some((other) => other !== box && other.kind !== "text" && inside(other, box, 0) && !inside(box, other, 0)),
      )
      .map((box) => box.id),
  );
  const leaves = usable.filter((box) => box.kind === "box" && !background.has(box.id));

  const problems: Array<string> = [];
  for (const box of usable) {
    const overflow = textOverflow(box);
    if (overflow) problems.push(overflow);
  }

  // A box poking out of the container it sits in, by structure or by drawing.
  for (const leaf of leaves) {
    const holder = leaf.parent ? byId.get(leaf.parent) : undefined;
    const frames = usable.filter(
      (other) =>
        background.has(other.id) && other !== leaf && (other === holder || overlaps(leaf, other)),
    );
    const poking = frames.find((frame) => !inside(leaf, frame));
    if (poking) {
      problems.push(
        `${named(leaf)} sticks out of ${named(poking)}: move it fully inside, or make ${named(poking)} bigger.`,
      );
    }
  }
  for (const [index, a] of leaves.entries()) {
    for (const b of leaves.slice(index + 1)) {
      if (overlaps(a, b) && !inside(a, b) && !inside(b, a)) {
        problems.push(`${named(a)} and ${named(b)} overlap: move one so they have a gap between them.`);
      }
    }
  }

  for (const edge of edges) {
    const from = edge.source ? byId.get(edge.source) : undefined;
    const to = edge.target ? byId.get(edge.target) : undefined;
    const routes = candidateRoutes(edge, from, to);
    if (routes.length === 0) continue;
    const ends = new Set([edge.source, edge.target]);
    const obstacles = leaves.filter(
      (box) =>
        !ends.has(box.id) &&
        !(from && inside(from, box)) &&
        !(to && inside(to, box)),
    );
    let blocked: ReadonlyArray<LayoutBox> = obstacles;
    for (const route of routes) {
      blocked = blocked.filter((box) => {
        const r = shrink(box, LINE_SLACK);
        return route.some((point, at) => at > 0 && segmentHits(route[at - 1]!, point, r));
      });
      if (blocked.length === 0) break;
    }
    if (blocked.length === 0) continue;
    const name = `${from ? named(from) : "a loose end"} -> ${to ? named(to) : "a loose end"}`;
    problems.push(
      `The connection ${name} runs through ${blocked.slice(0, 2).map(named).join(" and ")}. ` +
        `Give it bend points (<Array as="points">) that go around, through the gaps between boxes, or move the boxes.`,
    );
  }

  if (problems.length <= MAX_LAYOUT_WARNINGS) return problems;
  const rest = problems.length - MAX_LAYOUT_WARNINGS;
  return [
    ...problems.slice(0, MAX_LAYOUT_WARNINGS),
    `${rest} more layout problem${rest === 1 ? "" : "s"} like these: fix the ones above and save again to see them.`,
  ];
}
