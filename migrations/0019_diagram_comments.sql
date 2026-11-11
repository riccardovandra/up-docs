-- Comment threads on Draw.io diagrams, beside the doc comments in `comments`
-- rather than in it: those rows need a doc and a tab (NOT NULL, which SQLite
-- cannot relax without rebuilding the table) and travel through the doc's
-- room, while these belong to a diagram and go with it.
--
-- A thread root (parent_id NULL) holds the anchor and the resolve state;
-- replies point at their root. The anchor is the page (its name; NULL for a
-- diagram without named pages), the shape the pin snapped to (NULL for a pin
-- on empty space), and the point in diagram coordinates, kept for a shape pin
-- too so the pin stays put when its shape is deleted. `quote` is the shape's
-- label when the thread was started. `author` is an email, or "agent:<name>".

CREATE TABLE diagram_comments (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES diagram_comments(id) ON DELETE CASCADE,
  page TEXT,
  shape_id TEXT,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  quote TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX diagram_comments_diagram ON diagram_comments(diagram_id, created_at);
CREATE INDEX diagram_comments_parent ON diagram_comments(parent_id);
