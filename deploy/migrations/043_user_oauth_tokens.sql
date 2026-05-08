-- Per-user OAuth tokens for user-scoped provider integrations
-- (Google Workspace today: Drive / Docs / Sheets / Calendar / Gmail;
-- Microsoft 365 in the future: OneDrive / Word / Excel / Outlook /
-- Teams; any future provider that needs user-scoped API access).
--
-- Substrate for the documented provider model
-- (docs/providers/overview.md). Providers never see these rows.
-- The sidecar's user-token credential helper hits an internal api
-- endpoint that decrypts and returns a fresh access token per
-- outbound provider→external-API request.
--
-- Storage shape mirrors user_mcp_tokens (035) and workspace_secrets
-- (029): AES-256-GCM with the deployment-wide
-- WORKSPACE_SECRETS_MASTER_KEY. One cipher, one key, four callers.
--
-- Keyed on (user_id, provider). One token row per user per provider —
-- v1 assumes one Google account per user, one Microsoft account per
-- user, etc. Adding multi-account support later means lifting the
-- unique constraint and adding `account_id` to the key; non-breaking
-- additive change.

CREATE TABLE user_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Stable provider id matching AuthProvider.id ("google",
  -- "microsoft-365", "github", …). Free-form text rather than enum so
  -- new providers don't require a migration; the application layer
  -- validates the value at write time.
  provider TEXT NOT NULL,

  -- Encrypted access token. Required — every provider issues one on
  -- successful exchange.
  access_token_ciphertext BYTEA NOT NULL,
  access_token_nonce BYTEA NOT NULL,
  access_token_auth_tag BYTEA NOT NULL,

  -- Encrypted refresh token. Optional because:
  --   - Some providers don't issue one for short-lived tokens.
  --   - Implicit-flow grants don't have one.
  --   - Re-consent without prompt=consent on Google omits it.
  -- Without a refresh token, the next call after expiry returns
  -- permission_required and the user has to re-authenticate.
  refresh_token_ciphertext BYTEA,
  refresh_token_nonce BYTEA,
  refresh_token_auth_tag BYTEA,

  -- The set of OAuth scopes the user actually granted on this
  -- exchange (provider returns this; may be a subset of what we
  -- asked for if they unchecked some at consent). The application
  -- layer checks this against the scope a caller asks for.
  scopes_granted TEXT[] NOT NULL DEFAULT '{}',

  -- UTC. Computed at exchange time as now()+expires_in. Used to
  -- short-circuit a refresh round-trip when we know the token is
  -- still valid. NULL is treated as "always expired" — caller
  -- should refresh before use.
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, provider)
);

CREATE INDEX user_oauth_tokens_user_id_idx
  ON user_oauth_tokens (user_id);

-- Hot lookup is by (user_id, provider). The UNIQUE constraint above
-- already gives us the index for that path; no extra index needed.
