-- Per-user share grants on sessions.
--
-- A session "belongs to" the user who triggered it (sessions.triggered_by_user_id).
-- That user — and workspace admins/owners — can share the session with
-- other workspace members via this table. Sharees see the session in
-- their session list and can read its events; collaborators can also
-- send input messages.
--
-- v1 keeps roles simple — viewer reads only, collaborator reads + writes.
-- Future: pause/resume, take-over, etc.

CREATE TABLE session_user_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'collaborator')),
  shared_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per (session, user). Re-sharing updates role + shared_by
  -- via INSERT ... ON CONFLICT ... DO UPDATE in the adapter.
  UNIQUE (session_id, user_id)
);

-- Look up "what sessions are shared with me" — ordered by most-recent.
CREATE INDEX idx_session_user_shares_user ON session_user_shares (user_id, created_at DESC);
-- Look up "who is this session shared with" + uniqueness enforcement.
CREATE INDEX idx_session_user_shares_session ON session_user_shares (session_id);
