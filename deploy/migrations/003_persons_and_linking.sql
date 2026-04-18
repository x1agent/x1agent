-- 003_persons_and_linking
-- Persons let one human hold multiple Google identities. Authorization is
-- still per-user; person_id exists only for the account-switcher UX and
-- to prevent one human from having to be re-invited to every workspace
-- when they add a second Google account.

CREATE TABLE IF NOT EXISTS persons (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES persons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_person_id_idx ON users(person_id);

-- Backfill: one person per existing user. display_name uses the user name.
-- Idempotent via LEFT JOIN filter.
INSERT INTO persons (id, display_name, created_at)
  SELECT u.id, u.name, u.created_at
  FROM users u
  LEFT JOIN persons p ON p.id = u.id
  WHERE u.person_id IS NULL AND p.id IS NULL;

UPDATE users u
  SET person_id = u.id
  WHERE u.person_id IS NULL;

-- Short-lived link attempts. Single-use tokens bound to the initiating
-- person; the OAuth callback consumes them. Periodically swept.
CREATE TABLE IF NOT EXISTS link_attempts (
  state TEXT PRIMARY KEY,
  initiating_person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS link_attempts_expires_at_idx
  ON link_attempts(expires_at);

INSERT INTO schema_migrations (version) VALUES ('003_persons_and_linking')
  ON CONFLICT DO NOTHING;
