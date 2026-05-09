-- 046_session_summary
-- LLM-generated, human-readable session summary. Sessions today are only
-- addressable by their UUID; the API and the UI both fall back to a
-- truncated hash when they need to show "which session is this?".
-- This migration adds a sibling column on `sessions` so a periodic
-- summarizer can persist a 1-line description without needing a separate
-- table or join.
--
-- Three columns, all NULL-able. NULL means "no summary yet" and the UI
-- falls back to the existing hash slice. The trigger to (re)generate is
-- driven from the api process — see packages/api/src/nats/subscriber.ts —
-- and is bounded by event count and wall-clock to keep token spend low.
--
--   summary             one-line text, max ~100 chars (the prompt asks
--                       for short; we don't enforce in DB so a slightly
--                       longer model output isn't lost).
--   summary_updated_at  when the row was last summarized; powers the
--                       wall-clock cooldown ("don't re-summarize for N
--                       minutes after the last update").
--   summary_event_seq   the highest session_events.seq that was
--                       included in the most recent summary; powers
--                       the event-count cooldown ("don't re-summarize
--                       until at least N new events have arrived").

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS summary_event_seq INTEGER;

INSERT INTO schema_migrations (version)
  VALUES ('046_session_summary')
  ON CONFLICT DO NOTHING;
