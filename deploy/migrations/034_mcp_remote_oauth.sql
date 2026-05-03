-- Third MCP catalog shape: remote HTTP MCP server + OAuth 2.0.
--
-- Mercury, Notion, Linear's official server, etc. host the MCP
-- themselves and authenticate clients via OAuth (RFC 6749) with
-- Dynamic Client Registration (RFC 7591). Discovery happens through
-- RFC 9728 (Protected Resource Metadata) and RFC 8414 (Authorization
-- Server Metadata) at standard /.well-known URLs.
--
-- Shape model after this migration:
--   kind = 'stdio' (existing)
--     image    OR  command + args   — runs as a sibling pod container
--     workspace-admin holds the secrets, agent never sees them
--
--   kind = 'remote_oauth' (new)
--     url      — the MCP server's URL (no image, no command)
--     mcp_oauth_clients row holds the DCR-issued client_id +
--     encrypted client_secret. Per-user OAuth tokens land in a
--     separate per-user table (next slice).
--
-- Per-user constraint (enforced at attachment time, not in SQL):
-- remote_oauth entries can only be attached to worker agents — not
-- orchestrators or scheduled agents — because the agent acts AS the
-- person currently driving the session. Attaching to an unattended
-- agent kind would leak tokens to runs the user isn't present for.

ALTER TABLE mcp_catalog_entries
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'stdio',
  ADD COLUMN url TEXT,
  -- Cached RFC 8414 metadata. Populated from the discovery probe at
  -- registration time; refreshed on demand. Holding it here means a
  -- session-launch doesn't have to re-discover the server.
  ADD COLUMN oauth_authorization_server JSONB;

-- Drop the old image-XOR-command CHECK and replace with a kind-aware
-- shape check. Constraint name from migration 033.
ALTER TABLE mcp_catalog_entries
  DROP CONSTRAINT mcp_catalog_entries_image_xor_command;

ALTER TABLE mcp_catalog_entries
  ADD CONSTRAINT mcp_catalog_entries_kind_shape CHECK (
    (kind = 'stdio' AND url IS NULL AND (
       (image IS NOT NULL AND command IS NULL)
       OR (image IS NULL AND command IS NOT NULL)
    ))
    OR
    (kind = 'remote_oauth' AND url IS NOT NULL
       AND image IS NULL AND command IS NULL)
  );

-- DCR-issued OAuth client credentials per workspace MCP entry.
--
-- Separate from workspace_secrets because:
--   * client_secret is platform-internal (the operator never types it)
--   * It belongs to a specific catalog entry, not a workspace-wide
--     reference space
--   * Surfacing it as a "secret" in the env vars panel would confuse
--     the operator
--
-- Encryption reuses the workspace_secrets AES-256-GCM cipher with
-- the same WORKSPACE_SECRETS_MASTER_KEY — one cipher implementation,
-- one key-rotation procedure, two callers.
CREATE TABLE mcp_oauth_clients (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  catalog_entry_id UUID NOT NULL REFERENCES mcp_catalog_entries(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_secret_ciphertext BYTEA NOT NULL,
  client_secret_nonce BYTEA NOT NULL,
  client_secret_auth_tag BYTEA NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (catalog_entry_id)
);

CREATE INDEX mcp_oauth_clients_catalog_entry_id_idx
  ON mcp_oauth_clients (catalog_entry_id);
