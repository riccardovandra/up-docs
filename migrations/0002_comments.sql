-- Comments on tabs. A thread root (parent_id NULL) holds the anchor (quote with
-- prefix/suffix context, re-located against the tab's text on read) and the
-- resolve state; replies point at their root. Deleting a tab or doc removes
-- its comments.

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  quote TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX comments_doc ON comments(doc_id, tab_id, created_at);
CREATE INDEX comments_parent ON comments(parent_id);
