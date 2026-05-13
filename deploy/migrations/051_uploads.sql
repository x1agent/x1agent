-- Image uploads (X1A-96) — server-side storage for images dragged/dropped
-- into the composer. v1 is images-only (PNG/JPG/GIF/WebP). The
-- `storage_key` column is the source-of-truth path in block storage
-- (LocalDiskStorage in dev, S3 in prod); the bytes themselves never
-- live in Postgres. See packages/domains/uploads for the adapter layer.
--
-- Lifecycle (status column):
--   pending   row created at POST /api/uploads/init; bytes not yet uploaded.
--             expires_at = now() + UPLOAD_PENDING_TTL_HOURS.
--   ready     POST /api/uploads/:id/complete verified the bytes + MIME-sniff.
--             expires_at unchanged from pending; still subject to the
--             24-hour unattached TTL.
--   attached  the upload was attached to a message/session. expires_at
--             rolled forward to now() + UPLOAD_ATTACHED_TTL_DAYS.
--             Attachment is performed by the wire-format / composer
--             package (X1A-97 / X1A-100) — this domain just exposes the
--             repository method.
--   expired   the cleanup sweep observed expires_at < now() while the
--             row was still pending/ready. Storage object is deleted on
--             the same sweep; row hard-deleted 90 days later.
--   deleted   the user soft-deleted via DELETE /api/uploads/:id. Storage
--             object is removed on the next cleanup tick.
--
-- The (expires_at, status) index supports the cleanup sweep without a
-- seq scan. (user_id, status) supports the owner listing query. We do
-- NOT index storage_key — it's never a query predicate; lookups are
-- always by id.

CREATE TABLE uploads (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),

  -- The user who created the upload. NOT trusted from the request body;
  -- always derived from the authenticated session. ACL on every
  -- endpoint scopes to (uploads.user_id = caller.user_id).
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Optional session attachment. NULL for Case A uploads (user is
  -- composing a brand-new message before any session exists). Set once
  -- the upload is referenced from a session's message stream.
  -- Foreign key intentionally omitted (avoids a cycle with the
  -- per-session cascade on uploads) — the attaching code validates
  -- session existence in-process.
  session_id      UUID,

  -- Client-supplied filename, sanitized in the application layer
  -- (path separators / control chars / null bytes stripped, capped at
  -- 255). Used only for display + the path inside the agent container.
  filename        TEXT NOT NULL,

  -- Authoritative MIME type. At init time this carries the advisory
  -- client hint; complete() overwrites it with the magic-byte sniff
  -- result. v1 enforces image/png, image/jpeg, image/gif, image/webp.
  mime            TEXT NOT NULL,

  size_bytes      BIGINT NOT NULL,

  -- Storage adapter key. Convention: uploads/YYYY/MM/DD/<id>.<ext>
  -- (UTC). Time bucketing keeps cleanup cheap regardless of adapter.
  storage_key     TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','attached','expired','deleted')),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- When the row + its storage object become eligible for cleanup.
  -- pending/ready: now() + UPLOAD_PENDING_TTL_HOURS (default 24h).
  -- attached:      now() + UPLOAD_ATTACHED_TTL_DAYS (default 30d).
  -- The cleanup sweep transitions expired rows; 90 days after that
  -- the row is hard-deleted.
  expires_at      TIMESTAMPTZ NOT NULL,

  attached_at     TIMESTAMPTZ
);

-- Cleanup sweep: cheap range scan on (expires_at, status). Both
-- columns participate because the sweep filters on
-- "expires_at < now() AND status IN (...)".
CREATE INDEX uploads_expires_at_status_idx
  ON uploads (expires_at, status);

-- Owner listing query (the composer's "your uploads in this session").
CREATE INDEX uploads_user_id_status_idx
  ON uploads (user_id, status);

-- Session lookup (used when the wire-format parser resolves
-- [image: <id>] tokens against the session).
CREATE INDEX uploads_session_id_idx
  ON uploads (session_id)
  WHERE session_id IS NOT NULL;
