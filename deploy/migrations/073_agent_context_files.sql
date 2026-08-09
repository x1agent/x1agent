CREATE TABLE IF NOT EXISTS agent_context_files (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  path text NOT NULL,
  mime_type text NOT NULL,
  content text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 262144),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, path),
  CHECK (path !~ '(^/|(^|/)\.\.(/|$)|\\)')
);

CREATE INDEX IF NOT EXISTS agent_context_files_workspace_agent_idx
  ON agent_context_files (workspace_id, agent_id, path);

INSERT INTO schema_migrations (version) VALUES ('073_agent_context_files')
  ON CONFLICT DO NOTHING;
