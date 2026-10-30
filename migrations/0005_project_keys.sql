-- Projects are T3 Code projects. `key` is the stable identity T3 Code syncs
-- by: the git remote's canonical key (github.com/owner/repo), or
-- `title:<normalised title>` for a project with no remote. `name` is the
-- display name, updated from the latest T3 Code title. Existing projects get
-- title keys; SQL cannot collapse inner whitespace like projectNameKey does,
-- and a duplicate gets its id appended so the unique index holds.

ALTER TABLE projects ADD COLUMN key TEXT;
UPDATE projects SET key = 'title:' || lower(trim(name)) || CASE
  WHEN EXISTS (
    SELECT 1 FROM projects AS earlier
    WHERE lower(trim(earlier.name)) = lower(trim(projects.name)) AND earlier.rowid < projects.rowid
  ) THEN ':' || id
  ELSE ''
END;
CREATE UNIQUE INDEX projects_key ON projects(key);

-- Docs with no project ("No project") have a NULL project_id. SQLite cannot
-- drop NOT NULL in place, so docs is rebuilt. D1 keeps foreign keys on and
-- runs ON DELETE CASCADE even when they are deferred, so dropping docs empties
-- every table that references it: those rows are copied aside first and put
-- back after. SELECT * keeps columns other migrations added. A new table that
-- references docs must be added to this list if it lands before this file.

PRAGMA defer_foreign_keys = on;
CREATE TABLE saved_docs AS SELECT * FROM docs;
CREATE TABLE saved_tabs AS SELECT * FROM tabs;
CREATE TABLE saved_comments AS SELECT * FROM comments;
CREATE TABLE saved_doc_threads AS SELECT * FROM doc_threads;
CREATE TABLE saved_doc_members AS SELECT * FROM doc_members;
DROP TABLE docs;
CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'thinking',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX docs_project ON docs(project_id, updated_at DESC);
INSERT INTO docs (id, project_id, title, status, created_at, updated_at)
  SELECT id, project_id, title, status, created_at, updated_at FROM saved_docs;
INSERT INTO tabs SELECT * FROM saved_tabs;
INSERT INTO comments SELECT * FROM saved_comments;
INSERT INTO doc_threads SELECT * FROM saved_doc_threads;
INSERT INTO doc_members SELECT * FROM saved_doc_members;
DROP TABLE saved_docs;
DROP TABLE saved_tabs;
DROP TABLE saved_comments;
DROP TABLE saved_doc_threads;
DROP TABLE saved_doc_members;
PRAGMA defer_foreign_keys = off;
