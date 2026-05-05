-- 040_slack_bots
-- Per-bot Slack integration. Each x1agent workspace can configure
-- multiple named Slack bots; each bot is its own Slack app on Slack's
-- side, generated at runtime via Slack's manifest URL pattern. Bots
-- are workspace-level resources; pairing a bot with an agent is a
-- separate, optional step done from the agent edit page.
--
-- Three tables:
--   slack_bot_configs       — workspace-scoped bot definitions
--   slack_installs          — OAuth installs of a bot into a Slack team
--   slack_install_attempts  — single-use state tokens for OAuth state
--   slack_connected_channels — channels auto-registered on first event

CREATE TABLE IF NOT EXISTS slack_bot_configs (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A bot is paired with at most one agent. NULL until the workspace
  -- admin attaches it on the agent edit page.
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  -- The display handle for the bot in Slack (e.g. "triage"). Slugged
  -- per workspace so a Slack team can host multiple x1agent-managed
  -- bots without name collision on x1agent's side; Slack itself enforces
  -- per-team display-name uniqueness.
  bot_name TEXT NOT NULL,
  -- Slack's stable identifier for the underlying Slack app. NULL during
  -- the brief window between row creation and OAuth callback completion.
  slack_app_id TEXT,
  -- Slack's bot user id (e.g. "U01ABC"). Set once on first install.
  slack_bot_user_id TEXT,
  -- AES-256-GCM-encrypted Slack signing secret for *this* per-bot app.
  -- Captured via post-install paste-back: the OAuth flow returns the
  -- bot token and app_id but NOT the signing secret, so the user
  -- copies it from api.slack.com/apps/<app_id>/general after Slack
  -- creates the app. The events handler can't HMAC-verify inbound
  -- events until these columns are populated.
  signing_secret_ciphertext BYTEA,
  signing_secret_nonce BYTEA,
  signing_secret_auth_tag BYTEA,
  -- Either all three encrypted-blob columns are populated or none of
  -- them are. Without this, a partially-written row (e.g. mid-update
  -- crash, manual edit) could pass the application-layer
  -- has_signing_secret check while still failing to decrypt.
  CONSTRAINT signing_secret_all_or_none CHECK (
    (signing_secret_ciphertext IS NULL
      AND signing_secret_nonce IS NULL
      AND signing_secret_auth_tag IS NULL)
    OR
    (signing_secret_ciphertext IS NOT NULL
      AND signing_secret_nonce IS NOT NULL
      AND signing_secret_auth_tag IS NOT NULL)
  ),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, bot_name)
);

CREATE INDEX IF NOT EXISTS slack_bot_configs_workspace_idx
  ON slack_bot_configs(workspace_id);
CREATE INDEX IF NOT EXISTS slack_bot_configs_agent_idx
  ON slack_bot_configs(agent_id)
  WHERE agent_id IS NOT NULL;
-- A bot's Slack app id is unique once known. Partial index permits
-- multiple rows with NULL during creation.
CREATE UNIQUE INDEX IF NOT EXISTS slack_bot_configs_app_id_uidx
  ON slack_bot_configs(slack_app_id)
  WHERE slack_app_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS slack_installs (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  bot_config_id UUID NOT NULL REFERENCES slack_bot_configs(id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL,
  slack_team_name TEXT,
  -- AES-256-GCM encrypted bot token. Three columns mirror the
  -- workspace_secrets layout: ciphertext / nonce (96 bits) / auth tag
  -- (128 bits). The master key lives in WORKSPACE_SECRETS_MASTER_KEY
  -- (the same key used by workspace_secrets so we don't grow the
  -- key-management surface). Failing closed: the schema has no
  -- plaintext fallback column.
  bot_token_ciphertext BYTEA NOT NULL,
  bot_token_nonce BYTEA NOT NULL,
  bot_token_auth_tag BYTEA NOT NULL,
  installed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  -- (bot_config_id, slack_team_id) uniqueness lets a bot be installed
  -- into the same Slack team only once at a time. Re-installing into
  -- the same team replaces the row via upsert.
  UNIQUE (bot_config_id, slack_team_id)
);

CREATE INDEX IF NOT EXISTS slack_installs_bot_config_idx
  ON slack_installs(bot_config_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS slack_installs_team_idx
  ON slack_installs(slack_team_id)
  WHERE revoked_at IS NULL;


CREATE TABLE IF NOT EXISTS slack_install_attempts (
  state_token TEXT PRIMARY KEY,
  bot_config_id UUID NOT NULL REFERENCES slack_bot_configs(id) ON DELETE CASCADE,
  initiating_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Optional path to redirect back to after success. Validated for
  -- same-origin in the route handler before use.
  return_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS slack_install_attempts_expires_idx
  ON slack_install_attempts(expires_at)
  WHERE consumed_at IS NULL;


CREATE TABLE IF NOT EXISTS slack_connected_channels (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  install_id UUID NOT NULL REFERENCES slack_installs(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  -- Whether the bot should forward all channel messages to the agent
  -- (ambient mode) or only direct mentions and DMs. Default false —
  -- explicit invocation is the cost-bounded default.
  ambient BOOLEAN NOT NULL DEFAULT false,
  -- When the bot first received an event from this channel.
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Cleared when the bot is removed from the channel (member_left_channel).
  removed_at TIMESTAMPTZ,
  UNIQUE (install_id, channel_id)
);

CREATE INDEX IF NOT EXISTS slack_connected_channels_install_idx
  ON slack_connected_channels(install_id)
  WHERE removed_at IS NULL;


INSERT INTO schema_migrations (version) VALUES ('040_slack_bots')
  ON CONFLICT DO NOTHING;
