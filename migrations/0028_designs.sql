-- Designs: OpenPencil (.fig) files as library items of their own, next to
-- docs, Draw.io diagrams, sheets and pages. The editor runs in a frame on its
-- own origin and sends each save as the whole .fig file plus a PNG picture of
-- its current page. Every save is a new version; the last 20 are kept (see
-- worker/designs.ts, DESIGN_VERSIONS_KEPT) and older ones are deleted.
-- `version` is the latest save (0: a new design with no file yet).
-- `picture_version` is the version whose picture the cards show (NULL: none
-- yet). Bytes live in object storage under designs/<designId>/ (R2), or in
-- design_chunks for a deployment with no R2 bucket.
-- A design outlives its project (it moves to no project) and its creator's
-- account (then only the admin manages it). Deleting one removes it and every
-- version, as for diagrams.

CREATE TABLE designs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  picture_version INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX designs_creator ON designs(created_by, updated_at DESC);
CREATE INDEX designs_project ON designs(project_id, updated_at DESC);

-- One row per kept save. `token` names its objects, so a save that loses a
-- race never overwrites the winner's bytes.
CREATE TABLE design_versions (
  design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  token TEXT NOT NULL,
  fig_bytes INTEGER NOT NULL,
  picture_bytes INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (design_id, version)
);

-- People on a design, in the shape of diagram_members.
CREATE TABLE design_members (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX design_members_design_user ON design_members(design_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX design_members_design_email ON design_members(design_id, email) WHERE email IS NOT NULL;
CREATE INDEX design_members_user ON design_members(user_id);
CREATE INDEX design_members_email ON design_members(email);

-- Every design's creator owns it (none exist yet; kept for the rule's sake).
INSERT INTO design_members (id, design_id, user_id, email, role, added_by, created_at)
SELECT lower(hex(randomblob(16))), id, created_by, NULL, 'owner', created_by, created_at
FROM designs WHERE created_by IS NOT NULL;

-- Design bytes for deployments with no R2 bucket, in the shape of page_chunks.
CREATE TABLE design_chunks (
  design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  seq INTEGER NOT NULL,
  total INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (design_id, file, seq)
);
