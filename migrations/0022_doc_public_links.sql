-- Public links: a doc's owner can let anyone with the link read the doc, all
-- its tabs, read-only and without signing in. The token is the only
-- credential and opens this one doc. One link per doc; turning it off deletes
-- the row, and turning it on again makes a new token, so an old link stays dead.

CREATE TABLE doc_public_links (
  doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
