-- 067_session_runtime_override
-- The agent's runtime is the default, but a user/orchestrator may choose a
-- different runtime for a new session. Persist the choice so the pod can be
-- recreated with the same runtime and the session remains auditable.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS runtime_override TEXT
    CHECK (runtime_override IS NULL OR runtime_override IN ('claude_code', 'codex'));

INSERT INTO schema_migrations (version) VALUES ('067_session_runtime_override')
  ON CONFLICT DO NOTHING;
