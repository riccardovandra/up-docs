-- Public links for every kind of item: a doc, a Draw.io diagram, a page or a
-- sheet. Its owner lets anyone with the link see it, read-only and without
-- signing in. The token is the only credential and opens this one item. One
-- link per item; turning it off deletes the row, and turning it on again
-- makes a new token, so an old link stays dead.
--
-- Each kind has its own nullable column with its own foreign key, so deleting
-- the item deletes its link. Exactly one is set, the one `kind` names.

CREATE TABLE public_links (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('doc', 'diagram', 'page', 'sheet')),
  doc_id TEXT REFERENCES docs(id) ON DELETE CASCADE,
  diagram_id TEXT REFERENCES diagrams(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  sheet_id TEXT REFERENCES sheets(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (
    (doc_id IS NOT NULL) + (diagram_id IS NOT NULL) + (page_id IS NOT NULL) + (sheet_id IS NOT NULL) = 1
  ),
  CHECK (
    (kind = 'doc' AND doc_id IS NOT NULL)
    OR (kind = 'diagram' AND diagram_id IS NOT NULL)
    OR (kind = 'page' AND page_id IS NOT NULL)
    OR (kind = 'sheet' AND sheet_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX public_links_doc ON public_links(doc_id) WHERE doc_id IS NOT NULL;
CREATE UNIQUE INDEX public_links_diagram ON public_links(diagram_id) WHERE diagram_id IS NOT NULL;
CREATE UNIQUE INDEX public_links_page ON public_links(page_id) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX public_links_sheet ON public_links(sheet_id) WHERE sheet_id IS NOT NULL;

-- Links already out keep working: same tokens.
INSERT INTO public_links (token, kind, doc_id, created_by, created_at)
SELECT token, 'doc', doc_id, created_by, created_at FROM doc_public_links;

-- doc_public_links stays until a later migration drops it, so the Worker
-- version still running while this applies keeps serving its links.
