-- Saved copies of embedded posts (t3-embed blocks), one per doc and post. The
-- copy's image is a doc image under images/<docId>/. Rows go with their doc.

CREATE TABLE embed_snapshots (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, url)
);
