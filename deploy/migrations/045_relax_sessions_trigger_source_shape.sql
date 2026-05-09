-- 045_relax_sessions_trigger_source_shape
-- Allow scheduler-triggered sessions to optionally carry a
-- triggered_by_user_id.
--
-- Companion to migration 044. PR #61 introduced
-- agents.scheduled_run_as_user_id and updated schedule-due-sessions
-- to write that user id to sessions.triggered_by_user_id at cron
-- fire time, so remote_oauth MCPs can mint per-user tokens for
-- scheduled orchestrator turns.
--
-- The previous shape constraint required triggered_by_user_id IS NULL
-- whenever triggered_by='scheduler', which would reject the new
-- inserts the moment the scheduler next ticks for an agent with a
-- run-as user. Without this migration, every scheduled run of an
-- agent that has a run-as user (= every agent post-044 backfill)
-- fails with a constraint violation and the orchestrator never spawns.
--
-- Relaxed shape:
--   user      — user id required, no parent
--   scheduler — user id optional (NULL legacy, NOT NULL post-044), no parent
--   agent     — no user id, parent + parent_agent required
--
-- DROP-then-ADD because Postgres CHECK constraints don't support
-- IF EXISTS on ALTER … RENAME and CREATE OR REPLACE doesn't apply.
-- Idempotent: DROP IF EXISTS makes a re-run on a partially-applied
-- DB safe.

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_trigger_source_shape;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_trigger_source_shape CHECK (
    (triggered_by = 'user'
       AND triggered_by_user_id IS NOT NULL
       AND parent_session_id IS NULL)
    OR
    (triggered_by = 'scheduler'
       AND parent_session_id IS NULL)
    OR
    (triggered_by = 'agent'
       AND triggered_by_user_id IS NULL
       AND parent_session_id IS NOT NULL
       AND parent_agent_id IS NOT NULL)
  );

INSERT INTO schema_migrations (version)
  VALUES ('045_relax_sessions_trigger_source_shape')
  ON CONFLICT DO NOTHING;
