-- 008_session_events
-- Append-only log of wire events for a session. The api's NATS
-- subscriber writes each event here as it flows by on
-- x1.session.{id}.events. The session detail UI reads from this table
-- when it opens a run (to backfill history) and then subscribes to
-- NATS for live updates.
--
-- `seq` is the sequence number assigned by the sidecar — monotonically
-- increasing per session. We index on it so the UI can fetch "events
-- after N" when it reconnects.

CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS session_events_session_seq_idx
  ON session_events(session_id, seq);

INSERT INTO schema_migrations (version) VALUES ('008_session_events')
  ON CONFLICT DO NOTHING;
