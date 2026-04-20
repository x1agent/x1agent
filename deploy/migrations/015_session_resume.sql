-- 015_session_resume
-- Session resume: when a session ends (idle, hard-deadline, or clean
-- end_session), an admin can click "Resume" to continue where it left
-- off. The new session row points at the original via `resumed_from`;
-- at pod-spawn time the job-watcher walks the resume chain, fetches
-- the prior event log, and mounts a markdown summary at
-- /workspace/session_history.md so the agent can read past context
-- before handling the next user message.
--
-- This is a separate concern from parent_session_id (orchestrator ->
-- worker spawning): parent sessions are alive concurrently; resumed
-- sessions are always a continuation of something already terminal.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS resumed_from UUID REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sessions_resumed_from_idx
  ON sessions(resumed_from)
  WHERE resumed_from IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('015_session_resume')
  ON CONFLICT DO NOTHING;
