-- People on a Draw.io diagram, shared like a doc: the same roles and the same
-- shape as doc_members. Owners share, move and delete it; editors change it;
-- commenters comment; viewers see it. A pending invite (email) becomes a person
-- on first sign-in, as for docs. Seeing a diagram through a doc that links it
-- still works without a row here.

CREATE TABLE diagram_members (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX diagram_members_diagram_user ON diagram_members(diagram_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX diagram_members_diagram_email ON diagram_members(diagram_id, email) WHERE email IS NOT NULL;
CREATE INDEX diagram_members_user ON diagram_members(user_id);
CREATE INDEX diagram_members_email ON diagram_members(email);

-- Every diagram's creator owns it.
INSERT INTO diagram_members (id, diagram_id, user_id, email, role, added_by, created_at)
SELECT lower(hex(randomblob(16))), id, created_by, NULL, 'owner', created_by, created_at
FROM diagrams WHERE created_by IS NOT NULL;
