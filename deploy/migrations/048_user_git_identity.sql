-- Account-level git identity for worker commits (X1A-42).
--
-- When a worker session pod runs `git commit`, the resulting commit
-- attributes to the platform's GitHub App push principal because the
-- agent process has no GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL set in its
-- environment. The user-visible result is that every commit reads as
-- "x1agent[bot]" — anonymous bot output, not a person.
--
-- Fix: store a per-user git identity (display name + email) and have
-- the api's job watcher inject GIT_AUTHOR_* + GIT_COMMITTER_* into
-- the agent container's env at pod-creation time, so commits are
-- authored by the human who triggered the session.
--
-- This migration is the storage shape only — non-destructive,
-- nullable, no defaults that would back-populate existing rows. A
-- user with no identity set leaves the env unset and the existing
-- "x1agent[bot]" fallback is preserved (no regression for users who
-- haven't opted in yet).
--
-- Manual entry only in this slice. GitHub OAuth-driven discovery
-- (which would let us pre-fill from the user's verified GitHub email
-- list) is a follow-up; the columns are shaped to support it without
-- a schema change.
--
-- Out of scope here, intentionally:
--   - No backfill of historical commits.
--   - No GPG / signed commits — orthogonal feature.
--   - No noreply-email toggle.

ALTER TABLE users
  ADD COLUMN git_name TEXT,
  ADD COLUMN git_email TEXT;

-- Sanity bound — the values are forwarded into env vars and ultimately
-- into git's commit-trailer parser. A 200-char cap keeps obvious abuse
-- (multi-megabyte names) out without constraining real identities.
ALTER TABLE users
  ADD CONSTRAINT users_git_name_len_chk
    CHECK (git_name IS NULL OR char_length(git_name) BETWEEN 1 AND 200),
  ADD CONSTRAINT users_git_email_len_chk
    CHECK (git_email IS NULL OR char_length(git_email) BETWEEN 3 AND 200);

INSERT INTO schema_migrations (version) VALUES ('048_user_git_identity')
  ON CONFLICT DO NOTHING;
