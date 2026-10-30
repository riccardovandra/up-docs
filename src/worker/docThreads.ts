// T3 Code threads linked to a doc. Writes go through the DocRoom so open
// editors see the list change; these functions only touch D1.

import type { DocThreadLink } from "../shared/protocol.ts";
import { randomId } from "./crypto.ts";
import { NotFoundError } from "./docs.ts";

interface DocThreadRow {
  id: string;
  doc_id: string;
  environment_id: string;
  thread_id: string;
  title: string;
  created_at: number;
}

const toLink = (row: DocThreadRow): DocThreadLink => ({
  id: row.id,
  docId: row.doc_id,
  environmentId: row.environment_id,
  threadId: row.thread_id,
  title: row.title,
  createdAt: row.created_at,
});

export type DocThreadOp =
  | {
      readonly kind: "link";
      readonly environmentId: string;
      readonly threadId: string;
      readonly title: string;
    }
  | { readonly kind: "unlink"; readonly linkId: string };

export async function listDocThreads(
  db: D1Database,
  docId: string,
): Promise<ReadonlyArray<DocThreadLink>> {
  const { results } = await db
    .prepare("SELECT * FROM doc_threads WHERE doc_id = ? ORDER BY created_at, id")
    .bind(docId)
    .all<DocThreadRow>();
  return results.map(toLink);
}

/** Applies the op and returns the doc's full list, which is what editors receive. */
export async function applyDocThreadOp(
  db: D1Database,
  docId: string,
  op: DocThreadOp,
  now: number,
): Promise<ReadonlyArray<DocThreadLink>> {
  if (op.kind === "link") {
    // Linking the same thread again (a retried report) only refreshes its label.
    await db
      .prepare(
        `INSERT INTO doc_threads (id, doc_id, environment_id, thread_id, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc_id, environment_id, thread_id) DO UPDATE SET title = excluded.title`,
      )
      .bind(randomId(), docId, op.environmentId, op.threadId, op.title, now)
      .run();
  } else {
    const removed = await db
      .prepare("DELETE FROM doc_threads WHERE id = ? AND doc_id = ? RETURNING id")
      .bind(op.linkId, docId)
      .first();
    if (!removed) throw new NotFoundError("thread link");
  }
  return listDocThreads(db, docId);
}
