-- MCP server catalog — workspace-scoped registry of MCP server images
-- the agents in a workspace can attach to.
--
-- Per docs/providers/mcp-servers.md:
--   * Workspace admin registers an MCP image + manifest once.
--   * Manifest declares the env vars the MCP expects (kind: secret|value)
--     and the tool_scopes each tool maps to in the permission ledger.
--   * Manifest can be auto-fetched from the image (/mcp-manifest.json)
--     or pasted at registration time. v1 ships paste-only; auto-fetch
--     is additive in a later migration.
--
-- Names are workspace-scoped: two workspaces can each have a 'linear'
-- entry pointing at different images. The name is the key used in
-- the agent's mcpServers config and as the tool prefix
-- (mcp__<name>__<tool>).

CREATE TABLE mcp_catalog_entries (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Catalog name. Unique per workspace. Used as the mcpServers key in
  -- the agent's claude.json AND as the tool name prefix. Lowercase
  -- letters, digits, hyphens, underscores; must start with a letter.
  name TEXT NOT NULL,

  -- Optional human-readable label for the UI; falls back to name.
  display_name TEXT,

  -- OCI image reference, e.g. ghcr.io/org/linear-mcp:1.2.0
  image TEXT NOT NULL,

  -- Manifest JSON: { env: { NAME: { kind, label, required } }, tool_scopes: { ... } }
  -- Validated at save time by the application layer; stored opaque here.
  manifest JSONB NOT NULL,

  description TEXT NOT NULL DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE (workspace_id, name)
);

CREATE INDEX mcp_catalog_entries_workspace_id_idx
  ON mcp_catalog_entries (workspace_id);
