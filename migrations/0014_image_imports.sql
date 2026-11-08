-- Images copied from a link (agent writes, the import_image tool, editor
-- pastes), one row per doc and source link, so the same link is stored once.
-- The copy is a doc image under images/<docId>/<file>. Rows go with their doc.

CREATE TABLE image_imports (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  file TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, source_url)
);

-- One-time links an agent uses to upload an image file from its own machine
-- (prepare_image_upload). Only the token's hash is kept. The upload is checked
-- against user_id's role on the doc when it arrives.

CREATE TABLE image_upload_tokens (
  token_hash TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX image_upload_tokens_expiry ON image_upload_tokens(expires_at);
