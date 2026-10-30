-- When each person last opened each doc in the app, for the home page's
-- "Opened" date and sort. Only signed-in sessions count; agent tokens reading
-- a doc do not.

CREATE TABLE doc_opens (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX doc_opens_user ON doc_opens(user_id);
