-- 009_permission_grants
-- One table for every "this caller is allowed to do that". Covers spawn,
-- tool_scope, and every future capability. See
-- docs/src/content/docs/security/permission-grants.md.

CREATE TABLE IF NOT EXISTS permission_grants (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Who holds the grant. Exactly one of the two subject columns is set;
  -- Postgres enforces the foreign key on either side, which a single
  -- polymorphic column couldn't. The CHECK below enforces exclusivity.
  user_subject_id  UUID REFERENCES users(id)  ON DELETE CASCADE,
  agent_subject_id UUID REFERENCES agents(id) ON DELETE CASCADE,

  -- What they're allowed to do. `details` is a tagged union validated by
  -- the application layer per `grant_type`.
  grant_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Validity. `session_id` is set only when scope='session' (enforced by
  -- CHECK below). `consumed_at`/`revoked_at` are set on terminal events.
  scope TEXT NOT NULL CHECK (scope IN ('once', 'session', 'persistent')),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,

  -- Audit. Written once on insert, never mutated. Survives soft-delete.
  granted_by_user_id UUID NOT NULL REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,

  CONSTRAINT permission_grants_exactly_one_subject
    CHECK (num_nonnulls(user_subject_id, agent_subject_id) = 1),
  CONSTRAINT permission_grants_session_scope_shape
    CHECK (
      (scope = 'session'              AND session_id IS NOT NULL) OR
      (scope IN ('once', 'persistent') AND session_id IS NULL)
    )
);

-- Hot path: "does this agent have an active grant of type X?"
CREATE INDEX IF NOT EXISTS permission_grants_agent_active_idx
  ON permission_grants(agent_subject_id, grant_type)
  WHERE agent_subject_id IS NOT NULL
    AND revoked_at IS NULL
    AND consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS permission_grants_user_active_idx
  ON permission_grants(user_subject_id, grant_type)
  WHERE user_subject_id IS NOT NULL
    AND revoked_at IS NULL
    AND consumed_at IS NULL;

-- Audit scan: per-workspace history newest-first.
CREATE INDEX IF NOT EXISTS permission_grants_workspace_granted_at_idx
  ON permission_grants(workspace_id, granted_at DESC);

-- Parent/child session link. When an orchestrator spawns a child, we
-- record the parent session + agent here so the UI can render a tree
-- and the api can gate "who can cancel whom." NULL means the session
-- was triggered by a user or by the scheduler, not by another session.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID
    REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_agent_id UUID
    REFERENCES agents(id) ON DELETE SET NULL;

-- "list children of this session" — powers the tree view.
CREATE INDEX IF NOT EXISTS sessions_parent_session_id_idx
  ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

-- Extend triggered_by to cover agent-initiated spawns. The existing
-- check constraint only allowed 'user' and 'scheduler'; now it accepts
-- 'agent' too, and 'agent' sessions must have a parent_session_id.
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_triggered_by_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_triggered_by_check
    CHECK (triggered_by IN ('user', 'scheduler', 'agent'));

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_user_trigger_has_user;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_trigger_source_shape
    CHECK (
      (triggered_by = 'user'
        AND triggered_by_user_id IS NOT NULL
        AND parent_session_id IS NULL) OR
      (triggered_by = 'scheduler'
        AND triggered_by_user_id IS NULL
        AND parent_session_id IS NULL) OR
      (triggered_by = 'agent'
        AND triggered_by_user_id IS NULL
        AND parent_session_id IS NOT NULL
        AND parent_agent_id IS NOT NULL)
    );

INSERT INTO schema_migrations (version) VALUES ('009_permission_grants')
  ON CONFLICT DO NOTHING;
