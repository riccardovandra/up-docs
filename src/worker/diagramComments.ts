// Comment threads on Draw.io diagrams, shared by the REST API and the MCP
// tools. Access follows the diagram's own: anyone who may see the diagram
// reads its threads; its managers (creator and admin), and their agents,
// start, answer, resolve and reopen them. Open pages pick up changes by
// re-reading (see the diagram page), as they do for the diagram itself.

import {
  authorKindOf,
  layoutPage,
  parseDiagramAnchor,
  shapePinPoint,
  type DiagramComment,
  type DiagramCommentAnchor,
  type DiagramThread,
} from "../shared/diagramComments.ts";
import { readDrawioLayout } from "../shared/drawioModel.ts";
import { randomId } from "./crypto.ts";
import { NotFoundError } from "./docs.ts";

/** A comment or anchor the store refuses; `message` is written for the person or agent. */
export class InvalidDiagramCommentError extends Error {
  readonly code: "invalid_anchor" | "page_not_found" | "shape_not_found";

  constructor(code: InvalidDiagramCommentError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface Row {
  id: string;
  diagram_id: string;
  parent_id: string | null;
  page: string | null;
  shape_id: string | null;
  x: number;
  y: number;
  quote: string;
  body: string;
  author: string;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

const toComment = (row: Row): DiagramComment => ({
  id: row.id,
  diagramId: row.diagram_id,
  parentId: row.parent_id,
  anchor:
    row.parent_id === null ? { page: row.page, shapeId: row.shape_id, x: row.x, y: row.y } : null,
  quote: row.quote,
  body: row.body,
  author: row.author,
  authorKind: authorKindOf(row.author),
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Threads in creation order, each root with its replies in creation order. */
export function groupDiagramThreads(
  comments: ReadonlyArray<DiagramComment>,
): ReadonlyArray<DiagramThread> {
  const replies = new Map<string, Array<DiagramComment>>();
  for (const comment of comments) {
    if (comment.parentId === null) continue;
    replies.set(comment.parentId, [...(replies.get(comment.parentId) ?? []), comment]);
  }
  return comments.flatMap((comment) =>
    comment.parentId === null && comment.anchor !== null
      ? [{ ...comment, anchor: comment.anchor, replies: replies.get(comment.id) ?? [] }]
      : [],
  );
}

export async function listDiagramThreads(
  db: D1Database,
  diagramId: string,
): Promise<ReadonlyArray<DiagramThread>> {
  const { results } = await db
    .prepare("SELECT * FROM diagram_comments WHERE diagram_id = ? ORDER BY created_at, id")
    .bind(diagramId)
    .all<Row>();
  return groupDiagramThreads(results.map(toComment));
}

/** Open threads per diagram, for the library. */
export async function openThreadCounts(db: D1Database): Promise<ReadonlyMap<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT diagram_id, COUNT(*) AS open FROM diagram_comments
       WHERE parent_id IS NULL AND resolved_at IS NULL GROUP BY diagram_id`,
    )
    .all<{ diagram_id: string; open: number }>();
  return new Map(results.map((row) => [row.diagram_id, row.open]));
}

export async function getDiagramComment(
  db: D1Database,
  commentId: string,
): Promise<DiagramComment> {
  const row = await db
    .prepare("SELECT * FROM diagram_comments WHERE id = ?")
    .bind(commentId)
    .first<Row>();
  if (!row) throw new NotFoundError("comment");
  return toComment(row);
}

/** The thread holding `commentId`, root and replies. */
export async function getDiagramThread(
  db: D1Database,
  commentId: string,
): Promise<DiagramThread> {
  const comment = await getDiagramComment(db, commentId);
  const rootId = comment.parentId ?? comment.id;
  const thread = (await listDiagramThreads(db, comment.diagramId)).find(
    (candidate) => candidate.id === rootId,
  );
  if (!thread) throw new NotFoundError("comment");
  return thread;
}

/**
 * The anchor a new thread gets, checked against the diagram's source: the
 * page must exist, and a named shape must be on it. A shape anchor without a
 * point takes the shape's corner. Also returns the shape's label, the quote.
 */
export async function resolveNewAnchor(
  xml: string,
  input: unknown,
): Promise<{ readonly anchor: DiagramCommentAnchor; readonly quote: string }> {
  const parsed = parseDiagramAnchor(input);
  if (!parsed) {
    throw new InvalidDiagramCommentError(
      "invalid_anchor",
      'The anchor must be {page, shapeId} for a shape, or {page, x, y} for a point; page is the page name (null or absent for the first page).',
    );
  }
  const layouts = (await readDrawioLayout(xml)) ?? [];
  const layout = layoutPage(layouts, parsed.page);
  if (parsed.page !== null && layout === null) {
    throw new InvalidDiagramCommentError(
      "page_not_found",
      `The diagram has no page "${parsed.page}".`,
    );
  }
  const page = parsed.page ?? layout?.name ?? null;
  if (parsed.shapeId === null) {
    return { anchor: { page, shapeId: null, x: parsed.x!, y: parsed.y! }, quote: "" };
  }
  const shape = layout?.shapes.find((candidate) => candidate.id === parsed.shapeId);
  if (!shape) {
    throw new InvalidDiagramCommentError(
      "shape_not_found",
      `No shape with the id "${parsed.shapeId}" on ${page === null ? "the diagram" : `page "${page}"`}.`,
    );
  }
  const point = parsed.x === null ? shapePinPoint(shape) : { x: parsed.x, y: parsed.y! };
  return { anchor: { page, shapeId: shape.id, ...point }, quote: shape.label };
}

export async function createDiagramThread(
  db: D1Database,
  input: {
    readonly diagramId: string;
    readonly anchor: DiagramCommentAnchor;
    readonly quote: string;
    readonly body: string;
    readonly author: string;
    readonly now: number;
  },
): Promise<DiagramThread> {
  const id = randomId();
  const { anchor } = input;
  await db
    .prepare(
      `INSERT INTO diagram_comments (id, diagram_id, parent_id, page, shape_id, x, y, quote, body,
         author, resolved_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id,
      input.diagramId,
      anchor.page,
      anchor.shapeId,
      anchor.x,
      anchor.y,
      input.quote,
      input.body,
      input.author,
      input.now,
      input.now,
    )
    .run();
  return getDiagramThread(db, id);
}

/** Replies are flat: replying to a reply joins its thread. Returns the reply. */
export async function replyDiagramThread(
  db: D1Database,
  input: {
    readonly commentId: string;
    readonly body: string;
    readonly author: string;
    readonly now: number;
  },
): Promise<DiagramComment> {
  const target = await getDiagramComment(db, input.commentId);
  const id = randomId();
  await db
    .prepare(
      `INSERT INTO diagram_comments (id, diagram_id, parent_id, quote, body, author, created_at,
         updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      target.diagramId,
      target.parentId ?? target.id,
      input.body,
      input.author,
      input.now,
      input.now,
    )
    .run();
  return getDiagramComment(db, id);
}

/** Resolves or reopens the thread holding `commentId`. */
export async function resolveDiagramThread(
  db: D1Database,
  input: { readonly commentId: string; readonly resolved: boolean; readonly now: number },
): Promise<DiagramThread> {
  const target = await getDiagramComment(db, input.commentId);
  await db
    .prepare("UPDATE diagram_comments SET resolved_at = ?, updated_at = ? WHERE id = ?")
    .bind(input.resolved ? input.now : null, input.now, target.parentId ?? target.id)
    .run();
  return getDiagramThread(db, target.id);
}
