-- 047_relax_sessions_trigger_source_shape_for_agent_spawns
-- Allow agent-triggered (spawn) sessions to optionally carry a
-- triggered_by_user_id.
--
-- Companion to migration 045, which relaxed the scheduler branch of
-- sessions_trigger_source_shape to support PR #61's
-- agents.scheduled_run_as_user_id propagation. The agent branch was
-- left strict: it still required triggered_by_user_id IS NULL.
--
-- That left orchestrator-spawned children with no way to carry the
-- chain root's user attribution. Any child agent with a remote_oauth
-- (zone-3) MCP attached then failed pod creation in job-watcher with
-- "remote_oauth MCPs require a user-triggered session — no
-- triggered_by_user_id set". The fix in spawn-child-session.ts now
-- writes parent.triggered_by_user_id onto the child, but the old
-- check constraint rejects that insert with
-- "violates check constraint sessions_trigger_source_shape".
--
-- Relaxed shape (post-047):
--   user      — user id required, no parent
--   scheduler — user id optional (NULL legacy, NOT NULL post-044), no parent
--   agent     — user id optional (inherited from parent post-X1A-61),
--               parent + parent_agent required
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
       AND parent_session_id IS NOT NULL
       AND parent_agent_id IS NOT NULL)
  );

INSERT INTO schema_migrations (version)
  VALUES ('047_relax_sessions_trigger_source_shape_for_agent_spawns')
  ON CONFLICT DO NOTHING;
