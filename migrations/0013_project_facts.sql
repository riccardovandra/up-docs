-- Standing facts and house rules for a project ("We use NocoDB, never
-- Airtable"). Agents get them with every doc in the project, so a correction
-- made once is not made again. source_comment_id names the comment thread a
-- fact was learned from, when it came from resolve_comment's lesson.

CREATE TABLE project_facts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source_comment_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX project_facts_project ON project_facts(project_id, created_at);
