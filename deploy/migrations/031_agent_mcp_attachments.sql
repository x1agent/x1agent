-- Per-agent MCP server attachments. An agent in a workspace picks
-- entries from the workspace catalog (mcp_catalog_entries) and fills
-- in the env values the manifest declared. Two kinds of env values
-- the user can supply:
--   * kind:value  → literal string, lands in the MCP container env
--                   directly (no secret indirection)
--   * kind:secret → ${WORKSPACE_SECRET_NAME} reference, materialized
--                   at session-launch via valueFrom.secretKeyRef
--                   against the workspace's secret bundle.
--
-- The plaintext of a secret never enters this row. We store the bare
-- reference only; the runtime resolves it just-in-time when the pod
-- spec is generated.
--
-- tool_scopes_granted is reserved for the permission ledger: when the
-- agent attaches an MCP, the user can grant a subset of the scopes
-- the manifest declared. Empty array = "no tools enabled" (attachment
-- exists but pod-spec generator skips it). v1 ships with all scopes
-- granted by default for ergonomics; future migration narrows this.

CREATE TABLE agent_mcp_attachments (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  catalog_entry_id UUID NOT NULL REFERENCES mcp_catalog_entries(id) ON DELETE RESTRICT,

  -- User-supplied env config keyed by the env-var name from the
  -- manifest. Each value is one of:
  --   { "kind": "value", "value": "<literal>" }
  --   { "kind": "secret", "ref": "<WORKSPACE_SECRET_NAME>" }
  -- Validated at the application layer against the catalog entry's
  -- manifest at write time.
  env_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Reserved for the permission ledger. Array of tool-scope strings
  -- the user explicitly granted (subset of the manifest's tool_scopes).
  -- v1 default: all scopes from the manifest.
  tool_scopes_granted JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- An agent attaches each catalog entry at most once. To attach the
  -- same MCP twice with different config, register a second catalog
  -- entry with a different name.
  UNIQUE (agent_id, catalog_entry_id)
);

CREATE INDEX agent_mcp_attachments_agent_id_idx
  ON agent_mcp_attachments (agent_id);

CREATE INDEX agent_mcp_attachments_catalog_entry_id_idx
  ON agent_mcp_attachments (catalog_entry_id);
