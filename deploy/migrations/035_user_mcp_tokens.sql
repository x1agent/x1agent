-- Per-user OAuth tokens for remote_oauth MCPs (Mercury, Notion, etc.).
--
-- The agent acts AS the user driving the session. Each operator who
-- runs an agent that has an attached remote_oauth MCP authenticates
-- once at Notion / Mercury / etc.; the resulting tokens land here,
-- keyed on (user_id, catalog_entry_id). Same storage shape as
-- workspace_secrets — AES-256-GCM with the deployment-wide
-- WORKSPACE_SECRETS_MASTER_KEY. One cipher, one key-rotation
-- procedure, three callers (workspace_secrets, mcp_oauth_clients,
-- and now this).
--
-- Threat model: a compromised api could read these tokens (they
-- decrypt with the master key the api also holds). That's the same
-- blast radius as workspace_secrets. The pod-side proxy in PR 3
-- gets a per-session bearer projection via valueFrom.secretKeyRef
-- so plaintext never lands in the pod manifest.

CREATE TABLE user_mcp_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalog_entry_id UUID NOT NULL REFERENCES mcp_catalog_entries(id) ON DELETE CASCADE,

  access_token_ciphertext BYTEA NOT NULL,
  access_token_nonce BYTEA NOT NULL,
  access_token_auth_tag BYTEA NOT NULL,

  -- Refresh token may be absent for servers that don't issue one;
  -- in that case the user has to re-authenticate when access expires.
  refresh_token_ciphertext BYTEA,
  refresh_token_nonce BYTEA,
  refresh_token_auth_tag BYTEA,

  -- Best-effort expiry (UTC). The token endpoint returns expires_in
  -- (seconds); we compute now()+expires_in at exchange time. Used to
  -- short-circuit a token-endpoint round-trip when we know the token
  -- is still valid. Doesn't replace the actual 401 retry path.
  access_token_expires_at TIMESTAMPTZ,
  scope TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, catalog_entry_id)
);

CREATE INDEX user_mcp_tokens_user_id_idx
  ON user_mcp_tokens (user_id);
CREATE INDEX user_mcp_tokens_catalog_entry_id_idx
  ON user_mcp_tokens (catalog_entry_id);
