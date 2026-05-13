-- X1A-111 — Notifications: write-only foundation.
--
-- Stores one row per notification-worthy event so a future notification
-- center (X1A-112 read APIs, X1A-113 UI, X1A-114 expiration job) can
-- consume them. This migration ships the table + indexes only — the
-- application-layer writer + the three event subscribers land in the
-- same PR, but the subscribers are intentionally no-op stubs in v1 and
-- only become wired as their producer tickets land (X1A-73 mention
-- writes, X1A-110 reply parenthood, the share-grant flow).
--
-- Design calls — locked in the X1A-111 ticket body.
-- =================================================
--
-- 1. NO foreign keys. This table is write-hot — every @mention, reply
--    and share-grant in the platform produces a row, fan-out per
--    recipient. FK constraints on `user_id` / `workspace_id` would
--    serialize every insert behind a referenced-row lock, and we have
--    no business need (orphan rows after a user/workspace delete are
--    acceptable; the future cleanup sweep in X1A-114 handles them).
--    Indexes scope the read paths; the application layer enforces
--    workspace isolation on insert.
--
-- 2. `kind` is plain TEXT, no CHECK enum. v1 inserts `comment_mention`,
--    `comment_reply`, `share_grant`; adding a new kind shouldn't need
--    a migration. The application layer constrains the set.
--
-- 3. `payload` is JSONB and kind-specific. Schema lives in the
--    application/event-payload type; we don't enforce shape at the DB
--    level because (a) the consumer is one trusted writer and (b) we
--    want to evolve payload fields without a CHECK rewrite.
--
-- 4. `read_at` is present here even though this ticket NEVER writes
--    it. X1A-112's mark-read endpoint will fill it; defining the column
--    now means the consumer ticket is a code change, not a migration.
--
-- 5. `source_event_id` is the idempotency key. Re-firing the same NATS
--    event (replay, retry, at-least-once delivery) must not produce a
--    duplicate notification. The UNIQUE constraint on
--    `(user_id, source_event_id)` is the DB-level guarantee: the writer
--    uses `INSERT ... ON CONFLICT DO NOTHING` so a re-fire is a silent
--    no-op rather than a thrown unique violation. Scoped to `user_id`
--    (not global) so the same source event can fan out to multiple
--    recipients — one row per recipient, each idempotent on its own
--    recipient/event pair.
--
-- 6. Partitioning by `created_at` is anticipated but not implemented in
--    this ticket. Indexes are designed to survive monthly partitioning
--    without redesign: `created_at` participates in every read path.

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Recipient. NO foreign key — see header note 1. Application layer
  -- inserts UserId-validated values from kernel.
  user_id         UUID NOT NULL,

  -- Workspace scope for admin listings + future expiration sweeps.
  -- NO foreign key — see header note 1.
  workspace_id    UUID NOT NULL,

  -- Open enumeration: `comment_mention`, `comment_reply`, `share_grant`
  -- in v1; future kinds add without migration. See header note 2.
  kind            TEXT NOT NULL,

  -- Idempotency key. The NATS event id (or any other stable source
  -- identifier) the writer dedupes on. Per (user_id, source_event_id),
  -- a re-fire is a no-op. See header note 5.
  source_event_id TEXT NOT NULL,

  -- Kind-specific payload (actor_user_id, link, snippet, share_id…).
  -- Shape owned by the application-layer event-payload types.
  payload         JSONB NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Filled by the future mark-read endpoint (X1A-112). NULL means
  -- unread. This ticket NEVER writes it.
  read_at         TIMESTAMPTZ
);

-- Idempotency. `(user_id, source_event_id)` is unique so the writer's
-- `INSERT ... ON CONFLICT DO NOTHING` collapses replays of the same
-- source event for the same recipient back to a single row. Scoped to
-- the recipient (not global) because one source event can fan out — a
-- single mention-write may notify multiple users, one row each.
CREATE UNIQUE INDEX idx_notifications_user_source
  ON notifications (user_id, source_event_id);

-- Unread feed: "list this user's recent unread notifications". The
-- bell badge query in X1A-112. Composite (read_at NULLS FIRST,
-- created_at DESC) keeps unread newest-first and reads-then-unreads
-- collapse to the same index.
CREATE INDEX idx_notifications_user_unread_recent
  ON notifications (user_id, read_at NULLS FIRST, created_at DESC);

-- Per-kind feed: "show me only my mentions". Backs filter tabs in the
-- future notification center UI (X1A-113).
CREATE INDEX idx_notifications_user_kind_recent
  ON notifications (user_id, kind, created_at DESC);

-- Expiration sweep: "delete notifications older than N days". Used by
-- the cleanup job in X1A-114. Plain (created_at) so a future range
-- scan partitions cleanly.
CREATE INDEX idx_notifications_created_at
  ON notifications (created_at);
