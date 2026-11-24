-- People on a sheet, shared like a doc, a diagram or a page: the same roles
-- and the same shape as doc_members. Owners share, move and delete it;
-- editors change it; commenters and viewers see it (sheets have no comments
-- yet). A pending invite (email) becomes a person on first sign-in.

CREATE TABLE sheet_members (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX sheet_members_sheet_user ON sheet_members(sheet_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX sheet_members_sheet_email ON sheet_members(sheet_id, email) WHERE email IS NOT NULL;
CREATE INDEX sheet_members_user ON sheet_members(user_id);
CREATE INDEX sheet_members_email ON sheet_members(email);

-- Every sheet's creator owns it.
INSERT INTO sheet_members (id, sheet_id, user_id, email, role, added_by, created_at)
SELECT lower(hex(randomblob(16))), id, created_by, NULL, 'owner', created_by, created_at
FROM sheets WHERE created_by IS NOT NULL;
