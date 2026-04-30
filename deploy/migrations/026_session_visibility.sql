-- Match the agents schema: every session also gets a coarse visibility
-- flag separate from any per-subject grants. Defaults to 'private' to
-- preserve the policy added by the routes layer in the previous slice
-- (sessions are private to their owner unless explicitly shared).

ALTER TABLE sessions
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'workspace', 'via_grants'));
