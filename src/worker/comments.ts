// Comment service functions shared by the REST API and the MCP tools. Writes
// go through `applyCommentOp`, which the DocRoom runs so open editors hear
// about them; reads come straight from D1.

import { canComment, canShare, type DocRole } from "../shared/access.ts";
import {
  locateAnchor,
  parseStructuredAnchor,
  resolveStructuredAnchor,
  type DocAnchor,
  type StructuredAnchor,
  type StructuredAnchorTarget,
} from "../shared/anchors.ts";
import type { Comment, RoomMessage } from "../shared/protocol.ts";
import { AGENT_AUTHOR_PREFIX, isAgentAuthor } from "../shared/threads.ts";
import { randomId } from "./crypto.ts";
import { getTab, NotFoundError } from "./docs.ts";

export const MAX_COMMENT_LENGTH = 20_000;
export const MAX_QUOTE_LENGTH = 2_000;
export const MAX_CONTEXT_LENGTH = 200;

interface CommentRow {
  id: string;
  doc_id: string;
  tab_id: string;
  parent_id: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  anchor: string | null;
  body: string;
  author: string;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  docId: row.doc_id,
  tabId: row.tab_id,
  parentId: row.parent_id,
  quote: row.quote,
  prefix: row.prefix,
  suffix: row.suffix,
  anchor: parseStoredAnchor(row.anchor),
  body: row.body,
  author: row.author,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function parseStoredAnchor(json: string | null): StructuredAnchor | null {
  if (json === null) return null;
  try {
    return parseStructuredAnchor(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Who is acting on a comment: a person signed in with `email` (one of
 * `emails`, every address that signs in as them), or a named agent.
 * `docRole` is the person's, or for an agent its token owner's, role on the doc.
 */
export type CommentActor =
  | {
      readonly kind: "person";
      readonly email: string;
      readonly emails: ReadonlyArray<string>;
      readonly docRole: DocRole;
    }
  | { readonly kind: "agent"; readonly name: string; readonly docRole: DocRole };

export const actorAuthor = (
  actor:
    | { readonly kind: "person"; readonly email: string }
    | { readonly kind: "agent"; readonly name: string },
) => (actor.kind === "person" ? actor.email : `${AGENT_AUTHOR_PREFIX}${actor.name}`);

const isOwnComment = (actor: CommentActor, comment: Comment) =>
  actor.kind === "person"
    ? !isAgentAuthor(comment.author) && actor.emails.includes(comment.author)
    : comment.author === actorAuthor(actor);

/** Nobody rewrites someone else's words: people edit their own comments, an agent its own. */
export const canEditComment = (actor: CommentActor, comment: Comment) =>
  canComment(actor.docRole) && isOwnComment(actor, comment);

/** A doc owner may delete any comment on it; everyone else, agents included, only their own. */
export const canDeleteComment = (actor: CommentActor, comment: Comment) =>
  canComment(actor.docRole) &&
  ((actor.kind === "person" && canShare(actor.docRole)) || isOwnComment(actor, comment));

export async function listComments(
  db: D1Database,
  input: { readonly docId: string; readonly tabId?: string | undefined },
): Promise<ReadonlyArray<Comment>> {
  const statement =
    input.tabId === undefined
      ? db
          .prepare("SELECT * FROM comments WHERE doc_id = ? ORDER BY created_at, id")
          .bind(input.docId)
      : db
          .prepare("SELECT * FROM comments WHERE doc_id = ? AND tab_id = ? ORDER BY created_at, id")
          .bind(input.docId, input.tabId);
  const { results } = await statement.all<CommentRow>();
  return results.map(toComment);
}

export async function getComment(db: D1Database, commentId: string): Promise<Comment> {
  const row = await db
    .prepare("SELECT * FROM comments WHERE id = ?")
    .bind(commentId)
    .first<CommentRow>();
  if (!row) throw new NotFoundError("comment");
  return toComment(row);
}

export type AnchorStatus = "anchored" | "text_removed" | "orphaned";

/**
 * Whether a thread still has its place in the tab: a quote anchor whose text
 * is gone reads `text_removed`; a structured anchor whose cell or label is
 * gone reads `orphaned`. `tabText` is the tab's `markdownToText`, computed
 * only when a quote anchor needs it.
 */
export function anchorStatus(
  root: Comment,
  tab: { readonly markdown: string },
  tabText: () => string,
): AnchorStatus {
  if (root.anchor !== null) {
    return resolveStructuredAnchor(tab.markdown, root.anchor) ? "anchored" : "orphaned";
  }
  return locateAnchor(tabText(), root) ? "anchored" : "text_removed";
}

/** The quote stored with a structured anchor: the part's words, else the caller's label. */
export const structuredQuote = (target: StructuredAnchorTarget, fallback: string) =>
  (target.text || fallback).slice(0, MAX_QUOTE_LENGTH);

export type CommentOp =
  | {
      readonly kind: "create";
      readonly tabId: string;
      readonly anchor: DocAnchor;
      /** A cell or label anchor; `anchor.quote` then holds its text. */
      readonly structuredAnchor?: StructuredAnchor | null;
      readonly body: string;
      readonly author: string;
    }
  | {
      readonly kind: "reply";
      readonly commentId: string;
      readonly body: string;
      readonly author: string;
    }
  | { readonly kind: "edit"; readonly commentId: string; readonly body: string }
  | { readonly kind: "resolve"; readonly commentId: string; readonly resolved: boolean }
  | { readonly kind: "delete"; readonly commentId: string };

export type CommentOpResult =
  | { readonly kind: "created"; readonly comment: Comment }
  | { readonly kind: "updated"; readonly comment: Comment }
  | { readonly kind: "deleted"; readonly commentIds: ReadonlyArray<string> };

/** Applies one comment write. Call through the DocRoom of the comment's doc. */
export async function applyCommentOp(
  db: D1Database,
  op: CommentOp,
  now: number,
): Promise<CommentOpResult> {
  switch (op.kind) {
    case "create": {
      const tab = await getTab(db, op.tabId);
      return {
        kind: "created",
        comment: await insertComment(db, {
          id: randomId(),
          docId: tab.docId,
          tabId: tab.id,
          parentId: null,
          ...op.anchor,
          anchor: op.structuredAnchor ?? null,
          body: op.body,
          author: op.author,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      };
    }
    case "reply": {
      const target = await getComment(db, op.commentId);
      // Replies are flat: replying to a reply joins its thread.
      const root = target.parentId === null ? target : await getComment(db, target.parentId);
      return {
        kind: "created",
        comment: await insertComment(db, {
          id: randomId(),
          docId: root.docId,
          tabId: root.tabId,
          parentId: root.id,
          quote: "",
          prefix: "",
          suffix: "",
          anchor: null,
          body: op.body,
          author: op.author,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      };
    }
    case "edit": {
      const row = await db
        .prepare("UPDATE comments SET body = ?, updated_at = ? WHERE id = ? RETURNING *")
        .bind(op.body, now, op.commentId)
        .first<CommentRow>();
      if (!row) throw new NotFoundError("comment");
      return { kind: "updated", comment: toComment(row) };
    }
    case "resolve": {
      const target = await getComment(db, op.commentId);
      // Resolve state lives on the thread root, whichever comment was named.
      const row = await db
        .prepare("UPDATE comments SET resolved_at = ?, updated_at = ? WHERE id = ? RETURNING *")
        .bind(op.resolved ? now : null, now, target.parentId ?? target.id)
        .first<CommentRow>();
      if (!row) throw new NotFoundError("comment");
      return { kind: "updated", comment: toComment(row) };
    }
    case "delete": {
      const target = await getComment(db, op.commentId);
      const { results: replies } = await db
        .prepare("SELECT id FROM comments WHERE parent_id = ?")
        .bind(target.id)
        .all<{ id: string }>();
      // ON DELETE CASCADE removes a root's replies with it.
      await db.prepare("DELETE FROM comments WHERE id = ?").bind(target.id).run();
      return { kind: "deleted", commentIds: [target.id, ...replies.map((reply) => reply.id)] };
    }
  }
}

export function commentMessage(result: CommentOpResult, origin: string | null): RoomMessage {
  switch (result.kind) {
    case "created":
      return { type: "comment.created", comment: result.comment, origin };
    case "updated":
      return { type: "comment.updated", comment: result.comment, origin };
    case "deleted":
      return { type: "comment.deleted", commentIds: result.commentIds, origin };
  }
}

async function insertComment(db: D1Database, comment: Comment): Promise<Comment> {
  await db
    .prepare(
      `INSERT INTO comments (id, doc_id, tab_id, parent_id, quote, prefix, suffix, anchor, body,
         author, resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      comment.id,
      comment.docId,
      comment.tabId,
      comment.parentId,
      comment.quote,
      comment.prefix,
      comment.suffix,
      comment.anchor === null ? null : JSON.stringify(comment.anchor),
      comment.body,
      comment.author,
      comment.resolvedAt,
      comment.createdAt,
      comment.updatedAt,
    )
    .run();
  return comment;
}
