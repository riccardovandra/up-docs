-- Folders inside a project, shared by its docs, diagrams and sheets. A folder
-- nests under another folder of the same project (parent_id), or sits at the
-- project's top (NULL). Deleting a project deletes its folders, and an item
-- whose folder is deleted falls back to no folder. Moving an item to another
-- project clears its folder in the same UPDATE (docs.ts, diagrams.ts, sheets.ts).
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX folders_project ON folders(project_id);

ALTER TABLE docs ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE diagrams ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE sheets ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX docs_folder ON docs(folder_id);
CREATE INDEX diagrams_folder ON diagrams(folder_id);
CREATE INDEX sheets_folder ON sheets(folder_id);
