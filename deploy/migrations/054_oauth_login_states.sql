-- Migration 054: oauth_login_states
--
-- Backing table for OAuthLoginStateStore. Fixes t04 P0 #1
-- (login-CSRF on /auth/google): the route now mints a state + PKCE
-- verifier, persists them here keyed by `state`, and the callback
-- consumes the row atomically before exchanging the code.
--
-- See packages/domains/auth/src/domain/oauth-login-state.ts and
-- packages/domains/auth/src/adapters/postgres/postgres-oauth-login-state-store.ts.

CREATE TABLE IF NOT EXISTS oauth_login_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect_path TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_login_states_expires_at_idx
  ON oauth_login_states(expires_at);

INSERT INTO schema_migrations (version) VALUES ('054_oauth_login_states')
  ON CONFLICT DO NOTHING;
