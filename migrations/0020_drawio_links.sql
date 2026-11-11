-- One-time links an agent uses to move a Draw.io file between its machine and
-- the library without writing the XML into a tool call (prepare_drawio_upload,
-- read_drawio {downloadLink: true}). A 200 KB file is about 60,000 tokens to
-- type out and takes many minutes; a link sends it in under a second.
--
-- Only the token's hash is kept. `tool` is the MCP tool the upload runs
-- (create_drawio or update_drawio) or 'download'; `args_json` holds that tool's
-- arguments without the XML, which the upload brings. The link acts as the API
-- token that asked for it, so it stops working when that token is revoked.

CREATE TABLE drawio_link_tokens (
  token_hash TEXT PRIMARY KEY,
  tool TEXT NOT NULL CHECK (tool IN ('create_drawio', 'update_drawio', 'download')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_token_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX drawio_link_tokens_expiry ON drawio_link_tokens(expires_at);
