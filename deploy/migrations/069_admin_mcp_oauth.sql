-- Persistent OAuth 2.1 state for the public administrative MCP.
-- Raw authorization codes and bearer tokens are never stored: only
-- SHA-256 digests are persisted. Access is still gated independently by
-- ADMIN_MCP_ENABLED and each workspace's adminMcpEnabled setting.

CREATE TABLE IF NOT EXISTS admin_mcp_oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT,
  redirect_uris TEXT[] NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_mcp_oauth_consents (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES admin_mcp_oauth_clients(client_id) ON DELETE CASCADE,
  resource    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, client_id, resource)
);

CREATE TABLE IF NOT EXISTS admin_mcp_oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES admin_mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  resource        TEXT NOT NULL,
  scope           TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_mcp_oauth_codes_expires_idx
  ON admin_mcp_oauth_codes(expires_at);

CREATE TABLE IF NOT EXISTS admin_mcp_oauth_tokens (
  token_hash        TEXT PRIMARY KEY,
  token_kind        TEXT NOT NULL CHECK (token_kind IN ('access', 'refresh')),
  family_id         UUID NOT NULL,
  client_id         TEXT NOT NULL REFERENCES admin_mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource          TEXT NOT NULL,
  scope             TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  replaced_by_hash  TEXT
);

CREATE INDEX IF NOT EXISTS admin_mcp_oauth_tokens_family_idx
  ON admin_mcp_oauth_tokens(family_id);
CREATE INDEX IF NOT EXISTS admin_mcp_oauth_tokens_user_idx
  ON admin_mcp_oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS admin_mcp_oauth_tokens_expires_idx
  ON admin_mcp_oauth_tokens(expires_at);

INSERT INTO schema_migrations (version) VALUES ('069_admin_mcp_oauth')
  ON CONFLICT DO NOTHING;
