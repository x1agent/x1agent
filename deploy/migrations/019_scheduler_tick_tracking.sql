-- Anchor for computing the next scheduler tick, independent of whether
-- the tick creates a new session or injects into an existing one.
--
-- Workers and scheduled agents track "last tick fired" via the most
-- recent sessions row with triggered_by='scheduler' (see
-- SessionRepository.lastSchedulerRunFor). Orchestrators can't use
-- that path because they're singletons: after the first session
-- exists, subsequent ticks inject a user.message into it rather than
-- creating a new sessions row. Without a separate anchor the next-due
-- calculation would always see "no prior scheduler run" and fire
-- every tick forever.
--
-- last_scheduler_tick_at is the universal anchor. The scheduler
-- bumps it on every successful tick (create or inject). nextDueAfter
-- reads it first, falling back to agent.createdAt when null.
-- Nullable default so existing rows migrate cleanly.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS last_scheduler_tick_at TIMESTAMPTZ;
