-- A tab's last push into a Claude Doc (claude.ai), one row per tab and Claude
-- Doc. widget_map is JSON {slug: {nodeId, hash}}. Rows go with their tab.

CREATE TABLE claude_doc_links (
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  claude_doc_id TEXT NOT NULL,
  claude_doc_url TEXT NOT NULL,
  claude_tab_id TEXT NOT NULL,
  claude_body_id TEXT NOT NULL,
  widget_map TEXT NOT NULL,
  pushed_version INTEGER NOT NULL,
  pushed_rev INTEGER NOT NULL,
  pushed_at TEXT NOT NULL,
  PRIMARY KEY (tab_id, claude_doc_id)
);
