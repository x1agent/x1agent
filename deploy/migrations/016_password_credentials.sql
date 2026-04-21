-- Local email+password credentials. Stored on the user row because
-- there's one password per user and no need to support rotation
-- history yet. A null password_hash means "SSO only — this user
-- cannot sign in with a password." Rolling a password out to an SSO
-- user is an admin action (the `mise run quickstart` seeder is the
-- canonical caller today).
--
-- The hash is stored with its full argon2id parameter set so the
-- verifier can read "what was this hashed with?" from the string
-- itself and we can rotate KDF parameters without a migration.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ;
