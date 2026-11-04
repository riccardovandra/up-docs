-- A doc's group inside its project, such as "Strategy" or "Posts". Null means
-- no group. Free text: a project's groups are the values its docs carry, and an
-- embedding app can name the groups it shows.
ALTER TABLE docs ADD COLUMN doc_group TEXT;
