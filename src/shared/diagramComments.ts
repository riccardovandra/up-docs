// Comment threads on Draw.io diagrams: what a thread holds, where its pin goes,
// how a click on the picture becomes a point on the diagram, and what goes to
// the T3 Code chat. Shared by the Worker (store, API, MCP) and the page.

import { MAX_DRAWIO_PAGE_NAME_LENGTH, diagramPath } from "./drawio.ts";
import type { DrawioPageLayout, DrawioShapeBox } from "./drawioModel.ts";
import { isAgentAuthor } from "./threads.ts";

export const MAX_DIAGRAM_COMMENT_LENGTH = 20_000;
/** A point further out than this is not on any drawing. */
const MAX_COORDINATE = 1_000_000;

const SHAPE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
export const isShapeId = (value: unknown): value is string =>
  typeof value === "string" && SHAPE_ID.test(value);

/**
 * Where a thread is pinned: the page (by name; null for a diagram whose page
 * has none), the shape the pin snapped to (null for empty space), and the
 * point in diagram coordinates. A shape pin keeps its point, so it stays put
 * when the shape is deleted.
 */
export interface DiagramCommentAnchor {
  readonly page: string | null;
  readonly shapeId: string | null;
  readonly x: number;
  readonly y: number;
}

export type DiagramCommentAuthorKind = "person" | "agent";

export interface DiagramComment {
  readonly id: string;
  readonly diagramId: string;
  /** Null for a thread's root. */
  readonly parentId: string | null;
  /** The root's anchor; null on a reply. */
  readonly anchor: DiagramCommentAnchor | null;
  /** The shape's label when the thread started; "" for a point, and on a reply. */
  readonly quote: string;
  readonly body: string;
  /** An email, or "agent:<name>". */
  readonly author: string;
  readonly authorKind: DiagramCommentAuthorKind;
  /** On the root only: when the thread was resolved, or null while it is open. */
  readonly resolvedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DiagramThread extends DiagramComment {
  readonly anchor: DiagramCommentAnchor;
  readonly replies: ReadonlyArray<DiagramComment>;
}

export const authorKindOf = (author: string): DiagramCommentAuthorKind =>
  isAgentAuthor(author) ? "agent" : "person";

const isCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;

/**
 * Reads an anchor from untrusted input: `page` a name or null, `shapeId` an id
 * or absent, and `x`, `y` numbers. A shape anchor may leave out the point; the
 * caller then takes the shape's corner. Null when malformed.
 */
export function parseDiagramAnchor(
  value: unknown,
): { readonly page: string | null; readonly shapeId: string | null; readonly x: number | null; readonly y: number | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const page = raw.page ?? null;
  if (page !== null && (typeof page !== "string" || page.length > MAX_DRAWIO_PAGE_NAME_LENGTH)) {
    return null;
  }
  const shapeId = raw.shapeId ?? null;
  if (shapeId !== null && !isShapeId(shapeId)) return null;
  const hasPoint = raw.x !== undefined || raw.y !== undefined;
  if (hasPoint && (!isCoordinate(raw.x) || !isCoordinate(raw.y))) return null;
  if (!hasPoint && shapeId === null) return null;
  return {
    page,
    shapeId,
    x: hasPoint ? (raw.x as number) : null,
    y: hasPoint ? (raw.y as number) : null,
  };
}

/** The page of `layouts` a thread names: by name, or the first page for null. */
export function layoutPage(
  layouts: ReadonlyArray<DrawioPageLayout>,
  page: string | null,
): DrawioPageLayout | null {
  if (page === null) return layouts[0] ?? null;
  return layouts.find((layout) => layout.name === page) ?? null;
}

/** The point a shape pin sits on: the shape's top-right corner. */
export const shapePinPoint = (shape: DrawioShapeBox) => ({ x: shape.x + shape.width, y: shape.y });

export type PinStatus = "shape" | "point" | "shape_removed";

/**
 * Where a thread's pin goes on its page now. A shape pin follows its shape;
 * one whose shape is gone stays at its point (`shape_removed`), as does a pin
 * on empty space.
 */
export function pinPlacement(
  anchor: DiagramCommentAnchor,
  layout: DrawioPageLayout | null,
): { readonly x: number; readonly y: number; readonly status: PinStatus; readonly shape: DrawioShapeBox | null } {
  if (anchor.shapeId === null) return { x: anchor.x, y: anchor.y, status: "point", shape: null };
  const shape = layout?.shapes.find((candidate) => candidate.id === anchor.shapeId) ?? null;
  if (shape === null) return { x: anchor.x, y: anchor.y, status: "shape_removed", shape: null };
  return { ...shapePinPoint(shape), status: "shape", shape };
}

/**
 * The shape under a point: the last drawn (topmost) one whose box holds it, so
 * a shape inside a container wins over the container.
 */
export function shapeAt(
  layout: DrawioPageLayout | null,
  x: number,
  y: number,
): DrawioShapeBox | null {
  const shapes = layout?.shapes ?? [];
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index]!;
    if (shape.width <= 0 || shape.height <= 0) continue;
    if (x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height) {
      return shape;
    }
  }
  return null;
}

/**
 * How a page's picture sits over its diagram: picture coordinates (the SVG's
 * own units, from its viewBox) are diagram coordinates plus `dx`, `dy`.
 * `width` and `height` are the picture's size in those units.
 */
export interface PictureFrame {
  readonly viewX: number;
  readonly viewY: number;
  readonly width: number;
  readonly height: number;
  readonly dx: number;
  readonly dy: number;
}

const attribute = (tag: string, name: string): number | null => {
  const match = new RegExp(`\\s${name}="(-?[0-9.]+)(?:px)?"`).exec(tag);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

/**
 * Lines a page's SVG picture up with its layout. Draw.io draws each cell in a
 * `<g data-cell-id>`: a shape's first `<rect>` or `<ellipse>` of the shape's
 * size gives the offset exactly. Without one (only odd shapes, or an older
 * picture), the drawing's bounds stand at the picture's top-left. Null when
 * the text is not an SVG with a size.
 */
export function pictureFrame(svg: string, layout: DrawioPageLayout | null): PictureFrame | null {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0];
  if (!root) return null;
  const view = /\sviewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const [viewX, viewY, width, height] =
    view && view.length === 4 && view.every(Number.isFinite)
      ? (view as [number, number, number, number])
      : [0, 0, attribute(root, "width") ?? Number.NaN, attribute(root, "height") ?? Number.NaN];
  if (!(width > 0) || !(height > 0)) return null;
  const frame = { viewX, viewY, width, height };
  for (const shape of layout?.shapes ?? []) {
    const offset = shapeOffset(svg, shape);
    if (offset) return { ...frame, ...offset };
  }
  const bounds = layout?.bounds;
  return { ...frame, dx: viewX - (bounds?.x ?? 0), dy: viewY - (bounds?.y ?? 0) };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function shapeOffset(svg: string, shape: DrawioShapeBox): { dx: number; dy: number } | null {
  const start = svg.search(new RegExp(`data-cell-id="${escapeRegExp(shape.id)}"`));
  if (start === -1) return null;
  const next = svg.indexOf("data-cell-id=", start + 14);
  const body = svg.slice(start, next === -1 ? undefined : next);
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 1;
  const rect = /<rect\b[^>]*>/.exec(body)?.[0];
  if (rect && near(attribute(rect, "width"), shape.width) && near(attribute(rect, "height"), shape.height)) {
    return { dx: attribute(rect, "x")! - shape.x, dy: attribute(rect, "y")! - shape.y };
  }
  const ellipse = /<ellipse\b[^>]*>/.exec(body)?.[0];
  if (ellipse) {
    const cx = attribute(ellipse, "cx");
    const cy = attribute(ellipse, "cy");
    const rx = attribute(ellipse, "rx");
    const ry = attribute(ellipse, "ry");
    if (cx !== null && cy !== null && near(rx, shape.width / 2) && near(ry, shape.height / 2)) {
      return { dx: cx - rx! - shape.x, dy: cy - ry! - shape.y };
    }
  }
  return null;
}

/** A point on the shown picture (fractions 0..1 of its width and height) as diagram coordinates. */
export function pictureToDiagram(frame: PictureFrame, fx: number, fy: number) {
  return {
    x: frame.viewX + fx * frame.width - frame.dx,
    y: frame.viewY + fy * frame.height - frame.dy,
  };
}

/** A diagram point as fractions of the shown picture's width and height. */
export function diagramToPicture(frame: PictureFrame, x: number, y: number) {
  return {
    fx: (x + frame.dx - frame.viewX) / frame.width,
    fy: (y + frame.dy - frame.viewY) / frame.height,
  };
}

/** What T3 Code adds to its chat for a comment or reply on a diagram. */
export interface DiagramCommentChat {
  readonly diagramId: string;
  readonly diagramTitle: string;
  /** `<origin>/diagrams/<id>`. */
  readonly url: string;
  readonly page: string | null;
  /** The thread's root. */
  readonly commentId: string;
  /** The shape's label, or "" for a pin on empty space. */
  readonly quote: string;
  /** The words just written: the comment, or the reply. */
  readonly body: string;
}

export const diagramUrl = (origin: string, diagramId: string) => `${origin}${diagramPath(diagramId)}`;

/**
 * The chat text for a T3 Code that cannot take a diagram comment: pasted by
 * hand, it tells the agent what to act on and how to answer in the thread.
 */
export function diagramCommentChatText(chat: DiagramCommentChat): string {
  const where = [
    chat.page === null ? null : `page "${chat.page}"`,
    chat.quote ? `shape "${chat.quote}"` : null,
  ].filter(Boolean);
  return [
    `Comment on the UP Docs diagram "${chat.diagramTitle}" (${chat.url})${where.length > 0 ? `, ${where.join(", ")}` : ""}:`,
    chat.body,
    "",
    `Act on it: read_drawio {diagramId: "${chat.diagramId}"}, change the diagram with update_drawio, then reply_comment {diagramId: "${chat.diagramId}", commentId: "${chat.commentId}"} saying what changed, and resolve_comment once it is handled.`,
  ].join("\n");
}
