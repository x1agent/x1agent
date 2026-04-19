-- 011_audit_events
-- Sidecar emits one row per HTTP call it serves: which session, which
-- route, what method, what status, when. Powers the compliance trail
-- — "what did this agent actually do?" — without reading session
-- events one at a time.
--
-- Body content is intentionally NOT captured today. The audit answers
-- "agent called graph_write at 14:02 and got 200." For "what did it
-- write?" we still recommend reading the session events stream.
-- Verbose body capture lands in a follow-up if compliance demands it.

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  caller TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Hot path: per-session, newest-first.
CREATE INDEX IF NOT EXISTS audit_events_session_ts_idx
  ON audit_events(session_id, ts DESC);

-- Compliance scan: per-route across all sessions in a date range.
CREATE INDEX IF NOT EXISTS audit_events_route_ts_idx
  ON audit_events(route, ts DESC);

INSERT INTO schema_migrations (version) VALUES ('011_audit_events')
  ON CONFLICT DO NOTHING;
