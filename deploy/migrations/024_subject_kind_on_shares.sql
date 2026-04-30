-- Generalize session_user_shares from user-only to (subject_kind, subject_id).
--
-- subject_kind ∈ {user, group, workspace, public}. Today only 'user' is
-- written (the existing /user-shares routes), but every grant table from
-- this migration onward uses the same shape so adding 'group' later is
-- a resolver change, not a schema migration that touches every grant row.
--
-- The legacy `user_id` column stays for transition; the adapter writes
-- both for any subject_kind='user' row. A follow-up migration drops it
-- once all readers move to subject_id.

ALTER TABLE session_user_shares
  ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'user'
    CHECK (subject_kind IN ('user', 'group', 'workspace', 'public')),
  ADD COLUMN subject_id UUID;

UPDATE session_user_shares SET subject_id = user_id WHERE subject_id IS NULL;

-- For 'workspace' / 'public' subjects there's no per-row id; future
-- writes set NULL. NOT NULL stays only when subject_kind in (user,group).
-- Enforced by trigger or partial CHECK; for now we leave subject_id
-- nullable and add the consistency CHECK below.
ALTER TABLE session_user_shares
  ADD CONSTRAINT session_user_shares_subject_id_shape CHECK (
       (subject_kind IN ('user','group') AND subject_id IS NOT NULL)
    OR (subject_kind IN ('workspace','public') AND subject_id IS NULL)
  );

-- Replace the legacy uniqueness with the generalized one. The old
-- constraint allowed at most one row per (session, user). The new
-- one allows at most one row per (session, kind, id) — and a single
-- 'workspace' or 'public' row per session via partial unique indexes.
ALTER TABLE session_user_shares
  DROP CONSTRAINT IF EXISTS session_user_shares_session_id_user_id_key;

CREATE UNIQUE INDEX idx_session_user_shares_unique_subject
  ON session_user_shares (session_id, subject_kind, subject_id)
  WHERE subject_id IS NOT NULL;

CREATE UNIQUE INDEX idx_session_user_shares_unique_global_subject
  ON session_user_shares (session_id, subject_kind)
  WHERE subject_id IS NULL;
