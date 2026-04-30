-- Workspace-scoped groups. Three sources, all using one schema:
--
--   manual  — workspace admin creates the group + edits membership.
--   scim    — mirrored from an upstream identity provider via SCIM 2.0.
--             Membership is read-only on our side; a sync job overwrites.
--             external_id pins the IdP-side group id.
--   dynamic — membership computed at access-check time, no rows in
--             group_members. `rule` jsonb describes the predicate
--             (e.g. {"kind":"domain","value":"x1agent.com"}).
--
-- ACL grants (agent_grants, session_user_shares) reference groups via
-- subject_kind='group', subject_id=<group.id>. The resolver UNIONs the
-- three sources when checking membership.

CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'scim', 'dynamic')),
  external_id TEXT,
  rule JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug),
  CONSTRAINT groups_external_id_only_for_scim CHECK (
    (source = 'scim'    AND external_id IS NOT NULL) OR
    (source <> 'scim'   AND external_id IS NULL)
  ),
  CONSTRAINT groups_rule_only_for_dynamic CHECK (
    (source = 'dynamic' AND rule IS NOT NULL) OR
    (source <> 'dynamic' AND rule IS NULL)
  )
);

CREATE TABLE group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- "What groups is this user in?" — used by every grant resolver.
CREATE INDEX idx_group_members_user ON group_members (user_id);
