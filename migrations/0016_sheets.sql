-- Sheets: spreadsheets of their own in the library, beside docs and diagrams.
-- A sheet (a workbook) holds ordered tabs, and each tab its stored cells.
-- `revision` goes up by one for every edit list the sheet's SheetRoom applies;
-- the room writes the changed tabs and cells and the new revision in one batch.
-- Cells keep what was typed (`input`) and the cell format; computed values are
-- never stored, the engine recomputes them on load.
-- Tab ids (`s0-0`, `s4-1`, ...) are unique only within their sheet, so tabs are
-- keyed by (sheet_id, id). Rows and columns are 0-based.
-- Like a diagram, a sheet outlives its project (it moves to no project) and its
-- creator's account (then only the admin manages it). Deletes are hard deletes.

CREATE TABLE sheets (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sheets_creator ON sheets(created_by, updated_at DESC);
CREATE INDEX sheets_project ON sheets(project_id, updated_at DESC);

CREATE TABLE sheet_tabs (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  column_count INTEGER NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  column_widths TEXT NOT NULL DEFAULT '{}',
  row_heights TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (sheet_id, id)
);

CREATE TABLE sheet_cells (
  sheet_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  input TEXT NOT NULL,
  -- JSON CellFormat, NULL for none.
  format TEXT,
  PRIMARY KEY (sheet_id, tab_id, row, col),
  FOREIGN KEY (sheet_id, tab_id) REFERENCES sheet_tabs(sheet_id, id) ON DELETE CASCADE
);
