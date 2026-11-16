-- Draw.io parts: where each pictured page's parts (its top-level containers
-- with a label) sit in its picture, so a doc block can show one part alone.
-- A JSON array, one entry per pictured page, as the picture at
-- `picture_version` was drawn: {width, height, parts: [{name, x, y, width,
-- height}]} in the picture's units, or null for a page whose picture could
-- not be read. NULL: not known (a picture from before parts, or none).

ALTER TABLE diagrams ADD COLUMN picture_parts TEXT;
