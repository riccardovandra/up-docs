-- People and doc sharing. Every address in OWNER_EMAILS is the admin user
-- 'owner' (resolved in code, so the addresses stay config); everyone else
-- signs in by an address in user_emails. A doc's access is its doc_members
-- rows: a person (user_id) or a pending invite to an address nobody has
-- signed in with yet (email), which becomes a user row on first sign-in.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- NULL for the admin, whose primary address is the first of OWNER_EMAILS.
  email TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX user_emails_user ON user_emails(user_id);

CREATE TABLE doc_members (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX doc_members_doc_user ON doc_members(doc_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX doc_members_doc_email ON doc_members(doc_id, email) WHERE email IS NOT NULL;
CREATE INDEX doc_members_user ON doc_members(user_id);
CREATE INDEX doc_members_email ON doc_members(email);

-- Existing data belongs to the admin.
INSERT INTO users (id, email, name, created_at)
VALUES ('owner', NULL, 'Owner', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

ALTER TABLE api_tokens ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE api_tokens SET user_id = 'owner';

INSERT INTO doc_members (id, doc_id, user_id, email, role, added_by, created_at)
SELECT lower(hex(randomblob(16))), id, 'owner', NULL, 'owner', NULL, created_at FROM docs;
