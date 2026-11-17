// Layout checks for a Draw.io page, from geometry alone: labels that do not fit
// their box, boxes that overlap or stick out of the container they sit in,
// connections that run through or along the edge of a box that is neither of
// their ends, and connections drawn on top of each other. Draw.io's orthogonal
// router avoids only a line's own two ends, so an agent never sees these until
// a person opens the picture. Every check leans towards silence: text widths
// are estimates, and a line is reported only when every route Draw.io could
// plausibly take has the same problem.

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
  /**
   * A table: a container whose children are its rows (`childLayout=stackLayout`
   * or `shape=table`). Unlike other containers it is solid: a line must not cross it.
   */
  readonly table: boolean;
  /**
   * The sides connections attach to: "horizontal" for left or right only (a
   * table row, `portConstraint=eastwest`), "vertical" for top or bottom only.
   */
  readonly ports: "any" | "horizontal" | "vertical";
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
/** Two parallel lines this close or closer are drawn on top of each other. */
const SHARED_GAP = 3;
/** How long two connections may share a run before it is reported. */
const SHARED_MIN = 20;
/** A line this close to a box's border, outside or just inside, runs along it. */
const HUG_GAP = 6;
/** How long a line may run along a border before it is reported. */
const HUG_MIN = 20;
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

type Ports = LayoutBox["ports"];

/** Where an end attaches when its style names no point: the middle, or the side facing `toward` when only some sides take connections. */
function anchorOf(box: Rect, ports: Ports, toward: LayoutPoint): LayoutPoint {
  const middle = centre(box);
  if (ports === "horizontal") return { x: toward.x < middle.x ? box.x : box.x + box.width, y: middle.y };
  if (ports === "vertical") return { x: middle.x, y: toward.y < middle.y ? box.y : box.y + box.height };
  return middle;
}

/** The routes Draw.io could plausibly draw for an edge, each a polyline from its source to its target. */
function candidateRoutes(
  edge: LayoutEdge,
  from: LayoutBox | undefined,
  to: LayoutBox | undefined,
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  const fromPorts: Ports = from && !edge.exit ? from.ports : "any";
  const toPorts: Ports = to && !edge.entry ? to.ports : "any";
  // Each end faces the next point along the line: a bend point, else the other end.
  const towardStart = edge.points.at(-1) ?? (from ? centre(from) : edge.sourcePoint);
  const towardEnd = edge.points[0] ?? (to ? centre(to) : edge.targetPoint);
  const anchor = (
    box: LayoutBox | undefined,
    at: LayoutPoint | undefined,
    loose: LayoutPoint | undefined,
    ports: Ports,
    toward: LayoutPoint | undefined,
  ) => {
    if (!box) return loose;
    if (at) return { x: box.x + at.x * box.width, y: box.y + at.y * box.height };
    return anchorOf(box, ports, toward ?? centre(box));
  };
  const start = anchor(from, edge.exit, edge.sourcePoint, fromPorts, towardEnd);
  const end = anchor(to, edge.entry, edge.targetPoint, toPorts, towardStart);
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
    if (bottom - top > 0 && fromPorts !== "vertical" && toPorts !== "vertical") {
      // An end that takes lines only on its sides keeps its own height.
      const y = fromPorts === "horizontal" ? start.y : toPorts === "horizontal" ? end.y : (top + bottom) / 2;
      if (y >= top && y <= bottom) return [[{ x: start.x, y }, { x: end.x, y }]];
    }
    const left = Math.max(from.x, to.x);
    const right = Math.min(from.x + from.width, to.x + to.width);
    if (right - left > 0 && fromPorts !== "horizontal" && toPorts !== "horizontal") {
      const x = fromPorts === "vertical" ? start.x : toPorts === "vertical" ? end.x : (left + right) / 2;
      if (x >= left && x <= right) return [[{ x, y: start.y }, { x, y: end.y }]];
    }
  }
  // An end that takes lines only on some sides fixes how the route leaves or
  // arrives. With one such end Draw.io turns once, into the middle of the other
  // end; with two it draws the Z shape between them.
  if (fromPorts !== "any" || toPorts !== "any") {
    const horizontal = (fromPorts !== "any" ? fromPorts : toPorts) === "horizontal";
    if (fromPorts !== "any" && toPorts !== "any" && fromPorts === toPorts) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      return [
        horizontal
          ? [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]
          : [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end],
      ];
    }
    const leavesHorizontally = fromPorts !== "any" ? horizontal : !horizontal;
    return [[start, ...elbow(start, end, leavesHorizontally)]];
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

/** One straight run of a route: horizontal at y = `at` from `lo` to `hi`, or vertical at x = `at`. */
interface Run {
  readonly horizontal: boolean;
  readonly at: number;
  readonly lo: number;
  readonly hi: number;
}

/** A route's horizontal and vertical runs, less the parts inside `zones` (its ends, where lines meet anyway). */
function runsOf(route: ReadonlyArray<LayoutPoint>, zones: ReadonlyArray<Rect>): ReadonlyArray<Run> {
  let runs: Array<Run> = [];
  for (const [at, point] of route.entries()) {
    if (at === 0) continue;
    const before = route[at - 1]!;
    if (before.y === point.y && before.x !== point.x) {
      runs.push({ horizontal: true, at: point.y, lo: Math.min(before.x, point.x), hi: Math.max(before.x, point.x) });
    } else if (before.x === point.x && before.y !== point.y) {
      runs.push({ horizontal: false, at: point.x, lo: Math.min(before.y, point.y), hi: Math.max(before.y, point.y) });
    }
  }
  for (const zone of zones) {
    runs = runs.flatMap((run) => {
      const [across, acrossSize, along, alongSize] = run.horizontal
        ? [zone.y, zone.height, zone.x, zone.width]
        : [zone.x, zone.width, zone.y, zone.height];
      if (run.at <= across || run.at >= across + acrossSize) return [run];
      const parts: Array<Run> = [];
      if (run.lo < along) parts.push({ ...run, hi: Math.min(run.hi, along) });
      if (run.hi > along + alongSize) parts.push({ ...run, lo: Math.max(run.lo, along + alongSize) });
      return parts;
    });
  }
  return runs;
}

/** How far two routes run on top of each other, in px. */
function sharedLength(a: ReadonlyArray<Run>, b: ReadonlyArray<Run>): number {
  let total = 0;
  for (const one of a) {
    for (const other of b) {
      if (one.horizontal !== other.horizontal || Math.abs(one.at - other.at) > SHARED_GAP) continue;
      total += Math.max(0, Math.min(one.hi, other.hi) - Math.max(one.lo, other.lo));
    }
  }
  return total;
}

/** How far a route runs along one of the borders of `box`, in px, without entering it. */
function hugLength(runs: ReadonlyArray<Run>, box: Rect): number {
  let longest = 0;
  for (const run of runs) {
    const [lo, hi, borders] = run.horizontal
      ? [box.x, box.x + box.width, [box.y, box.y + box.height]]
      : [box.y, box.y + box.height, [box.x, box.x + box.width]];
    const [near, far] = borders as [number, number];
    // Along a border, outside it or just inside: deeper in is a line through the box.
    const along =
      (run.at >= near - HUG_GAP && run.at <= near + LINE_SLACK) ||
      (run.at >= far - LINE_SLACK && run.at <= far + HUG_GAP);
    if (along) longest = Math.max(longest, Math.min(run.hi, hi) - Math.max(run.lo, lo));
  }
  return longest;
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
  // A table is solid, though: its rows are part of it, and a line across it hides them.
  const background = new Set(
    usable
      .filter(
        (box) =>
          !box.table &&
          (box.kind === "container" ||
            parents.has(box.id) ||
            usable.some(
              (other) => other !== box && other.kind !== "text" && inside(other, box, 0) && !inside(box, other, 0),
            )),
      )
      .map((box) => box.id),
  );
  const leaves = usable.filter((box) => box.table || (box.kind === "box" && !background.has(box.id)));
  /** The table a box is part of (a row, or a cell of a row), if any. */
  const tableOf = (box: LayoutBox): LayoutBox | undefined => {
    let at = box.parent ? byId.get(box.parent) : undefined;
    for (let depth = 0; at && depth < 50; depth += 1) {
      if (at.table) return at;
      at = at.parent ? byId.get(at.parent) : undefined;
    }
    return undefined;
  };
  // A connection names a row by its own words and its table's.
  const endName = (box: LayoutBox | undefined) => {
    if (!box) return "a loose end";
    const table = tableOf(box);
    return table ? `${named(box)} (in ${named(table)})` : named(box);
  };

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
        other !== leaf && (other === holder || (background.has(other.id) && overlaps(leaf, other))),
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

  // A table's rows and cells are covered by the table itself.
  const solid = leaves.filter((box) => !tableOf(box));
  const drawn: Array<{ edge: LayoutEdge; name: string; routes: ReadonlyArray<ReadonlyArray<Run>> }> = [];
  for (const edge of edges) {
    const from = edge.source ? byId.get(edge.source) : undefined;
    const to = edge.target ? byId.get(edge.target) : undefined;
    const routes = candidateRoutes(edge, from, to);
    if (routes.length === 0) continue;
    const ends = new Set([edge.source, edge.target]);
    const obstacles = solid.filter(
      (box) =>
        !ends.has(box.id) &&
        !(from && inside(from, box)) &&
        !(to && inside(to, box)),
    );
    const name = `${endName(from)} -> ${endName(to)}`;
    let blocked: ReadonlyArray<LayoutBox> = obstacles;
    for (const route of routes) {
      blocked = blocked.filter((box) => {
        const r = shrink(box, LINE_SLACK);
        return route.some((point, at) => at > 0 && segmentHits(route[at - 1]!, point, r));
      });
      if (blocked.length === 0) break;
    }
    if (blocked.length > 0) {
      problems.push(
        `The connection ${name} runs through ${blocked.slice(0, 2).map(named).join(" and ")}. ` +
          `Give it bend points (<Array as="points">) that go around, through the gaps between boxes, or move the boxes.`,
      );
    }

    // Lines meet inside their own ends, and inside the table a row belongs to.
    const zones = [from, to, from && tableOf(from), to && tableOf(to)].filter((box) => box !== undefined);
    const runs = routes.map((route) => runsOf(route, zones));
    drawn.push({ edge, name, routes: runs });
    const hugged = obstacles.filter(
      (box) => !blocked.includes(box) && runs.every((route) => hugLength(route, box) > HUG_MIN),
    );
    if (hugged.length > 0) {
      problems.push(
        `The connection ${name} runs along the edge of ${hugged.slice(0, 2).map(named).join(" and ")}, ` +
          `so it reads as part of the box. Give it bend points that keep it 20 px or more away, or move the box.`,
      );
    }
  }

  // Two connections sharing a run cannot be told apart. Lines that fan out of
  // one shape or into one shape may share the run next to it: that is one bus.
  for (const [index, a] of drawn.entries()) {
    for (const b of drawn.slice(index + 1)) {
      if (
        (a.edge.source !== undefined && a.edge.source === b.edge.source) ||
        (a.edge.target !== undefined && a.edge.target === b.edge.target)
      ) {
        continue;
      }
      let shared = Infinity;
      for (const one of a.routes) {
        for (const other of b.routes) shared = Math.min(shared, sharedLength(one, other));
      }
      if (shared > SHARED_MIN) {
        problems.push(
          `The connections ${a.name} and ${b.name} run on top of each other for ${Math.round(shared)} px. ` +
            `Move one with bend points.`,
        );
      }
    }
  }

  if (problems.length <= MAX_LAYOUT_WARNINGS) return problems;
  const rest = problems.length - MAX_LAYOUT_WARNINGS;
  return [
    ...problems.slice(0, MAX_LAYOUT_WARNINGS),
    `${rest} more layout problem${rest === 1 ? "" : "s"} like these: fix the ones above and save again to see them.`,
  ];
}
