-- 006_sessions
-- A session is one run of an agent. `triggered_by` says who asked for it:
-- 'user' (with triggered_by_user_id populated) or 'scheduler' (null user id).
-- The scheduler relies on the unique index over (agent_id, triggered_at) to
-- de-duplicate cron ticks — see docs/architecture/sessions.md.

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  triggered_by TEXT NOT NULL
    CHECK (triggered_by IN ('user', 'scheduler')),
  triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sessions_user_trigger_has_user
    CHECK (
      (triggered_by = 'user'      AND triggered_by_user_id IS NOT NULL) OR
      (triggered_by = 'scheduler' AND triggered_by_user_id IS NULL)
    )
);

-- Scheduler idempotency: two ticks that compute the same triggered_at for
-- the same agent cannot both insert. The loser gets a duplicate-key error
-- and moves on.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_agent_triggered_at_uq
  ON sessions(agent_id, triggered_at);

-- Main list query: newest-first per agent.
CREATE INDEX IF NOT EXISTS sessions_agent_triggered_at_desc_idx
  ON sessions(agent_id, triggered_at DESC);

-- Executor will walk this to find work to claim.
CREATE INDEX IF NOT EXISTS sessions_status_pending_idx
  ON sessions(status, triggered_at)
  WHERE status = 'pending';

INSERT INTO schema_migrations (version) VALUES ('006_sessions')
  ON CONFLICT DO NOTHING;
