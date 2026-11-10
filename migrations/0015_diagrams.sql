-- Draw.io diagrams: library items of their own, linked from docs by id in a
-- ```t3-drawio block, so one save updates every doc that shows the diagram.
-- `xml` is the Draw.io source and the source of truth. `version` goes up on
-- every source change. `picture_version` is the version the stored picture was
-- drawn from (NULL: no picture yet); behind `version`, the next browser that
-- shows the diagram redraws it.
-- A diagram outlives its project (it moves to no project) and its creator's
-- account (then only the admin manages it).

CREATE TABLE diagrams (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  xml TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  picture_version INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX diagrams_creator ON diagrams(created_by, updated_at DESC);
CREATE INDEX diagrams_project ON diagrams(project_id, updated_at DESC);

-- Picture bytes for deployments with no R2 bucket, in the shape of
-- image_chunks: `total` rows of base64 per file, numbered by seq from 0.
-- Rows go with their diagram.

CREATE TABLE diagram_chunks (
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  seq INTEGER NOT NULL,
  total INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (diagram_id, file, seq)
);
