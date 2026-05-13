-- 050_session_model_override (originally landed as 047; renumbered after
-- it collided with 047_relax_sessions_trigger_source_shape_for_agent_spawns)
-- Per-spawn Claude model override on the session row.
--
-- Until now the Claude model a session ran under was decided by the
-- agent (agents.model column) with the deployment-wide ANTHROPIC_MODEL
-- env as the fallback. That left the orchestrator's heartbeat playbook
-- with no way to make per-spawn choices — "cheap routine work on
-- sonnet, critical migration on opus" couldn't be expressed without
-- editing the child agent's record on every spawn.
--
-- This column captures the spawner's per-spawn choice. The pod-spec
-- precedence becomes: session.model_override > agent.model >
-- ANTHROPIC_MODEL env. The internal /sessions/spawn route is the only
-- writer; user-triggered and scheduler-triggered sessions leave it
-- NULL and inherit the agent default. The X1A-37 cost rollup joins on
-- this column so per-spawn spend attributes to the model actually in
-- effect.
--
-- The admin-curated enabled-models allowlist is re-checked at the
-- spawn route before the value lands here — same gate the agent-edit
-- form uses for agents.model. A platform admin disabling a model is
-- still authoritative for new spawns; in-flight sessions keep running
-- on whatever they were started with.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS model_override TEXT;

INSERT INTO schema_migrations (version) VALUES ('050_session_model_override')
  ON CONFLICT DO NOTHING;
