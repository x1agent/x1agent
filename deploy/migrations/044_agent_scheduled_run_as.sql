-- 044_agent_scheduled_run_as
-- Per-agent "run as" user for scheduler-triggered sessions.
--
-- Background. The scheduler ticks every 30s and fires a session for any
-- agent whose schedule slot has elapsed. Until now those sessions had
-- triggered_by_user_id = NULL because there was no human in the loop to
-- attribute them to. That's fine for agents that only use stdio MCPs,
-- but agents with Zone-3 / remote_oauth MCPs (Google Workspace, Linear,
-- Notion …) need a per-user OAuth token to function — and the
-- credential proxy refuses to mint one for a session with no user
-- attribution. Result: scheduled orchestrators with Google attached
-- failed at session start with "remote_oauth MCPs require a
-- user-triggered session — no triggered_by_user_id set".
--
-- Fix: let the admin pick which user the scheduler should impersonate
-- per agent. Stored on the agent so the scheduler can read it without
-- joining users at every tick. Defaults on agent create to
-- agents.created_by — backfilled here for every existing row.
--
-- Validation that the picked user is a workspace member of the agent's
-- workspace lives in the application layer (workspace membership is a
-- separate domain). The FK here is plain users(id) ON DELETE SET NULL
-- so deleting a user doesn't cascade-delete agents; a stale NULL
-- surfaces a clear "pick another user" error at next save.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS scheduled_run_as_user_id UUID
    REFERENCES users(id) ON DELETE SET NULL;

-- Backfill: every existing agent gets its creator as the default
-- scheduled-run-as user. Idempotent — only fills NULLs, so re-running
-- the migration on a partially-applied database is safe.
UPDATE agents
   SET scheduled_run_as_user_id = created_by
 WHERE scheduled_run_as_user_id IS NULL
   AND created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS agents_scheduled_run_as_user_idx
  ON agents(scheduled_run_as_user_id)
  WHERE scheduled_run_as_user_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('044_agent_scheduled_run_as')
  ON CONFLICT DO NOTHING;
