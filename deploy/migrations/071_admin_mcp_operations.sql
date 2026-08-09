-- Durable retry protection and audit trail for administrative MCP mutations.
CREATE TABLE IF NOT EXISTS admin_mcp_idempotency (
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oauth_client_id text NOT NULL REFERENCES admin_mcp_oauth_clients(client_id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'in_progress'
    CHECK (state IN ('in_progress', 'completed', 'failed')),
  resource_id text,
  sanitized_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, oauth_client_id, tool_name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS admin_mcp_idempotency_updated_idx
  ON admin_mcp_idempotency (updated_at);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  oauth_client_id text NOT NULL,
  source text NOT NULL DEFAULT 'mcp' CHECK (source = 'mcp'),
  tool_name text NOT NULL,
  resource_type text,
  resource_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'error')),
  error_code text,
  request_id uuid NOT NULL,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_events_workspace_created_idx
  ON admin_audit_events (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_actor_created_idx
  ON admin_audit_events (actor_user_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('071_admin_mcp_operations')
  ON CONFLICT DO NOTHING;
