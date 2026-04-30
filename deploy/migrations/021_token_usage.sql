-- Token usage capture per session result message.
--
-- Source of truth for billing + per-workspace × per-agent dashboards.
-- One row per agent turn (the Claude Agent SDK emits one final `result`
-- message with the cumulative usage counters; the api persists it as it
-- arrives over NATS). The same data also feeds an OTel metric in a
-- follow-up — Postgres stays the durable record.
--
-- workspace_id + agent_id are denormalized at write time so dashboard
-- queries don't need a 3-table join on every cell.

CREATE TABLE IF NOT EXISTS token_usage (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id                    UUID          REFERENCES agents(id)     ON DELETE SET NULL,
  -- Anthropic returns the model on every result; capture it so per-model
  -- pricing differences (Sonnet vs Opus vs Haiku) are visible.
  model                       TEXT NOT NULL,
  -- All four counters from Anthropic's usage object. NULL for any the
  -- provider didn't return (forward-compat for new fields).
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  -- Sequence number from the wire envelope. Used as the dedup key
  -- alongside session_id so a NATS replay never double-counts.
  event_seq                   INTEGER NOT NULL,
  ts                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: same session + sequence = exactly-once write.
CREATE UNIQUE INDEX IF NOT EXISTS token_usage_dedup_idx
  ON token_usage (session_id, event_seq);

-- Hot dashboard queries:
--   - "this workspace's tokens this month, broken down by agent"
--   - "per-day burn rate for an agent"
-- Both filter on (workspace_id, ts) and group by (agent_id, model).
CREATE INDEX IF NOT EXISTS token_usage_workspace_ts_idx
  ON token_usage (workspace_id, ts DESC);

CREATE INDEX IF NOT EXISTS token_usage_workspace_agent_ts_idx
  ON token_usage (workspace_id, agent_id, ts DESC);

-- Per-session drill-down for the session detail page.
CREATE INDEX IF NOT EXISTS token_usage_session_idx
  ON token_usage (session_id, ts);

COMMENT ON TABLE token_usage IS
  'One row per agent turn (Claude SDK result message). Source for billing + dashboards.';
COMMENT ON COLUMN token_usage.event_seq IS
  'NATS envelope sequence — dedup key with session_id.';
