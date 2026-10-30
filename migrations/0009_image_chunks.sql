-- Image bytes for deployments with no R2 bucket. D1 caps a row at 2 MB, so an
-- image spans `total` rows of base64, numbered by seq from 0. Rows go with their doc.

CREATE TABLE image_chunks (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  seq INTEGER NOT NULL,
  total INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (doc_id, file, seq)
);
