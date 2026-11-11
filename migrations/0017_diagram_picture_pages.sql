-- Draw.io pages: one picture per page. `picture_pages` is a JSON array of the
-- page names (null for a page with none), in order, as the picture at
-- `picture_version` was drawn. Page 0's picture keeps the key it always had,
-- diagrams/<id>/<version>.<svg|png>; page N's is diagrams/<id>/<version>.p<N>.<svg|png>.
-- NULL: a picture drawn before pages were known, which shows the first page.

ALTER TABLE diagrams ADD COLUMN picture_pages TEXT;
