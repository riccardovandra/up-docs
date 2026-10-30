-- Structured comment anchors: JSON naming a part of a block by id, such as
-- {"kind":"cell","blockId":...,"rowId":...,"colId":...} for a rich table
-- cell or {"kind":"label","blockId":...,"textId":...} for a diagram label.
-- NULL keeps the quote anchor (quote, prefix, suffix). A structured thread
-- still stores the part's text as its quote, for display.

ALTER TABLE comments ADD COLUMN anchor TEXT;
