-- 055_agent_idle_timeout
-- Per-agent override for IDLE_TIMEOUT_MS the agent process honours.
-- NULL = use the platform default (15 min for workers / scheduled
-- agents; 7 days for orchestrators) which lives in
-- packages/api/src/k8s/job-watcher.ts. When set, the job-watcher
-- multiplies by 1000 to populate IDLE_TIMEOUT_MS on the session
-- pod's env.
--
-- Stored as seconds (not ms) so the column is human-readable in
-- ad-hoc SQL and the UI input maps directly without conversion.
-- INT covers the practical range (1s up to ~68 years).

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS idle_timeout_seconds INT;

-- Sanity bound — minimum 30s (any lower and a single LLM call can
-- exceed the timeout). No upper bound enforced at the DB; the api
-- write path clamps to 7 days for safety.
ALTER TABLE agents
  ADD CONSTRAINT agents_idle_timeout_seconds_min
  CHECK (idle_timeout_seconds IS NULL OR idle_timeout_seconds >= 30);

INSERT INTO schema_migrations (version) VALUES ('055_agent_idle_timeout')
  ON CONFLICT DO NOTHING;
