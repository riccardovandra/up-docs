-- Pages: uploaded HTML files (interactive prototypes) as library items of
-- their own, next to docs, Draw.io diagrams and sheets. Each upload is a new
-- version; versions are never overwritten, so older ones stay readable. The
-- HTML lives in object storage under pages/<pageId>/<version>.html (R2), or in
-- page_chunks for a deployment with no R2 bucket. A page is shared like a
-- diagram: its people (page_members) hold the doc roles, and a doc that embeds
-- it in a ```t3-page block shows it to that doc's readers (see pages.ts).
-- A page outlives its project and folder (it moves to none) and its creator's
-- account (then only the admin manages it).

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pages_creator ON pages(created_by, updated_at DESC);
CREATE INDEX pages_project ON pages(project_id, updated_at DESC);
CREATE INDEX pages_folder ON pages(folder_id);

-- One row per upload. `version` counts from 1 per page.
CREATE TABLE page_versions (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, version)
);

-- People on a page, in the shape of diagram_members.
CREATE TABLE page_members (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX page_members_page_user ON page_members(page_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX page_members_page_email ON page_members(page_id, email) WHERE email IS NOT NULL;
CREATE INDEX page_members_user ON page_members(user_id);
CREATE INDEX page_members_email ON page_members(email);

-- Page HTML for deployments with no R2 bucket, in the shape of diagram_chunks.
CREATE TABLE page_chunks (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  seq INTEGER NOT NULL,
  total INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (page_id, file, seq)
);

-- One-time links an agent uses to send a page file from its machine
-- (prepare_page_upload) or save one (read_page {downloadLink: true}), in the
-- shape of drawio_link_tokens. Only the token's hash is kept.
CREATE TABLE page_link_tokens (
  token_hash TEXT PRIMARY KEY,
  tool TEXT NOT NULL CHECK (tool IN ('create_page', 'update_page', 'download')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_token_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX page_link_tokens_expiry ON page_link_tokens(expires_at);
