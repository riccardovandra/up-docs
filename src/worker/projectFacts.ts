// Standing facts for a project: what agents must know before writing any doc
// in it. Read with every doc, written by the admin or a project's editors.

import { isAdmin } from "../shared/access.ts";
import { randomId } from "./crypto.ts";

export const MAX_FACT_LENGTH = 500;
export const MAX_FACTS_PER_PROJECT = 100;

export interface ProjectFact {
  readonly factId: string;
  readonly projectId: string;
  readonly text: string;
  readonly sourceCommentId: string | null;
  readonly createdAt: number;
}

interface FactRow {
  id: string;
  project_id: string;
  text: string;
  source_comment_id: string | null;
  created_at: number;
}

export class TooManyFactsError extends Error {
  constructor() {
    super("too_many_facts");
    this.name = "TooManyFactsError";
  }
}

const toFact = (row: FactRow): ProjectFact => ({
  factId: row.id,
  projectId: row.project_id,
  text: row.text,
  sourceCommentId: row.source_comment_id,
  createdAt: row.created_at,
});

/** The project's facts, oldest first. */
export async function listFacts(db: D1Database, projectId: string): Promise<ProjectFact[]> {
  const { results } = await db
    .prepare("SELECT * FROM project_facts WHERE project_id = ? ORDER BY created_at, id")
    .bind(projectId)
    .all<FactRow>();
  return results.map(toFact);
}

export async function getFact(db: D1Database, factId: string): Promise<ProjectFact | null> {
  const row = await db
    .prepare("SELECT * FROM project_facts WHERE id = ?")
    .bind(factId)
    .first<FactRow>();
  return row ? toFact(row) : null;
}

/** Adds a fact. The count check runs in the insert, so two writers cannot pass the cap together. */
export async function addFact(
  db: D1Database,
  input: {
    projectId: string;
    text: string;
    createdBy: string;
    sourceCommentId?: string | null;
    now: number;
  },
): Promise<ProjectFact> {
  const id = randomId();
  const row = await db
    .prepare(
      `INSERT INTO project_facts (id, project_id, text, source_comment_id, created_by, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT COUNT(*) FROM project_facts WHERE project_id = ?2) < ?7
       RETURNING *`,
    )
    .bind(
      id,
      input.projectId,
      input.text,
      input.sourceCommentId ?? null,
      input.createdBy,
      input.now,
      MAX_FACTS_PER_PROJECT,
    )
    .first<FactRow>();
  if (!row) throw new TooManyFactsError();
  return toFact(row);
}

export async function removeFact(db: D1Database, factId: string): Promise<void> {
  await db.prepare("DELETE FROM project_facts WHERE id = ?").bind(factId).run();
}

/** Whether the user may change a project's facts: the admin, or an owner or editor of one of its docs. */
export async function canEditFacts(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<boolean> {
  if (isAdmin(userId)) return true;
  const row = await db
    .prepare(
      `SELECT 1 FROM docs d JOIN doc_members m ON m.doc_id = d.id
       WHERE d.project_id = ? AND m.user_id = ? AND m.role IN ('owner', 'editor') LIMIT 1`,
    )
    .bind(projectId, userId)
    .first();
  return row !== null;
}
