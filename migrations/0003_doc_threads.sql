-- T3 Code threads started from a doc ("Start work"). The ids are T3 Code's:
-- a thread is only openable from the environment that owns it, so the
-- environment id is part of the key. The title is the label to show when
-- that environment is not the one embedding the doc.

CREATE TABLE doc_threads (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (doc_id, environment_id, thread_id)
);
CREATE INDEX doc_threads_doc ON doc_threads(doc_id, created_at);
