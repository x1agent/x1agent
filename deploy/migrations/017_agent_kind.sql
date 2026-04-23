-- Agent kind — the explicit discriminator between workers (short-lived,
-- one-session-per-trigger) and orchestrators (long-lived singleton that
-- commissions work to child agents). Scheduled agents are workers with
-- cron-based triggers.
--
-- The enum is closed (CHECK constraint) on purpose: adding a fourth kind
-- is a deliberate schema change, not an ad-hoc label. Pod-spec branches
-- on this column at Job-creation time; see
-- docs/architecture/orchestration.md § Pod-shape by kind.
--
-- Default is 'worker' so existing agents migrate cleanly. Flipping an
-- agent to 'orchestrator' is an operator action in the edit UI (and
-- requires the spawn grants to be configured separately — kind is
-- orthogonal to permissions).

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'worker'
    CHECK (kind IN ('worker', 'orchestrator', 'scheduled'));
