CREATE TABLE IF NOT EXISTS mcp_feedback (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  tags TEXT NOT NULL,
  tool_names TEXT NOT NULL,
  context TEXT NOT NULL,
  subject TEXT,
  client_id TEXT,
  session_id TEXT,
  token_fingerprint TEXT,
  scopes TEXT NOT NULL,
  client_name TEXT,
  client_version TEXT,
  user_agent TEXT,
  server_name TEXT,
  server_version TEXT,
  triage_note TEXT,
  triaged_by TEXT
);

CREATE INDEX IF NOT EXISTS mcp_feedback_created_idx ON mcp_feedback (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS mcp_feedback_status_idx ON mcp_feedback (status);

CREATE INDEX IF NOT EXISTS mcp_feedback_kind_idx ON mcp_feedback (kind);

CREATE INDEX IF NOT EXISTS mcp_feedback_server_idx ON mcp_feedback (server_name);
