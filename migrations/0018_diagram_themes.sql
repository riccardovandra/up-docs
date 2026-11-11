-- Diagram themes: colours, fonts and box and arrow styles for Draw.io
-- diagrams. Built-in themes (`neutral`, `uplifted`) live in code; this table
-- holds the custom ones people make. `tokens` is the theme's token set as JSON,
-- checked by the app on every write.
-- A diagram's effective theme is its own `theme_id`, else its project's
-- `diagram_theme_id`, else Neutral. Either column names a built-in id or a row
-- here, so neither has a foreign key: deleting a custom theme sets both back to
-- NULL in the same batch.

CREATE TABLE diagram_themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tokens TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX diagram_themes_creator ON diagram_themes(created_by, name);

ALTER TABLE projects ADD COLUMN diagram_theme_id TEXT;
ALTER TABLE diagrams ADD COLUMN theme_id TEXT;
