-- Short-lived, single-use authorization transactions bind consent to the
-- signed-in user and the exact validated OAuth request. This prevents a
-- same-site sibling from forging the approval POST with the user's cookie.

CREATE TABLE IF NOT EXISTS admin_mcp_oauth_authorization_requests (
  token_hash       TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES admin_mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri     TEXT NOT NULL,
  resource         TEXT NOT NULL,
  scope            TEXT NOT NULL,
  code_challenge   TEXT NOT NULL,
  state            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_mcp_oauth_authorization_requests_expires_idx
  ON admin_mcp_oauth_authorization_requests(expires_at);

INSERT INTO schema_migrations (version) VALUES ('070_admin_mcp_oauth_hardening')
  ON CONFLICT DO NOTHING;
