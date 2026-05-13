-- X1A-107: groups backend foundation — extends the existing groups +
-- group_members tables (migration 027) with the columns the Groups
-- feature (X1A-15) needs: human-authored description, who-created-it
-- audit pointers, and soft-delete via archived_at so past share rows
-- can keep showing a group label even after the group is "deleted".
--
-- Why a new migration rather than editing 027:
--   027 has been deployed in dev clusters since April. The grants
--   resolver consumes it. Edit-in-place would force every cluster
--   through a destructive recreate; an additive migration is safe to
--   apply to any cluster that already has 027.
--
-- What stays unchanged:
--   * The `slug` column and its UNIQUE (workspace_id, slug) constraint.
--     Slug is still the URL-safe handle the agent-grants flow uses to
--     reference groups by name. The new "name uniqueness scoped to
--     active manual groups" index ADDS to that — it doesn't replace.
--   * The CHECK constraints on (source, external_id) and (source, rule).
--   * The agent-grants / session_user_shares foreign-key shape
--     (subject_kind='group', subject_id=<group.id>).
--   * The three group sources: manual / scim / dynamic. X1A-107 only
--     touches the `manual` slice; the SCIM/dynamic columns and code
--     paths are left alone.
--
-- Resolution-at-share-time semantics (locked in X1A-15) live in the
-- share-recipient picker (X1A-109), not here. This migration is
-- schema-only — no behavioural change to existing tables.

-- Human-facing description shown in the Groups settings UI. Nullable
-- so existing groups don't need a backfill. 500-char limit enforced
-- at the API layer; we don't want a CHECK constraint here because
-- relaxing it later would be another migration.
ALTER TABLE groups
  ADD COLUMN description TEXT;

-- Who created this group. No FK constraint to users(id) because users
-- can be archived / hard-deleted in the future and a dangling
-- created_by should NOT cascade-delete the group (groups outlive their
-- creator). The column is nullable so the existing rows from migration
-- 027 don't need backfill — they predate this concept.
ALTER TABLE groups
  ADD COLUMN created_by UUID;

-- Soft-delete marker. NULL = active. When set, the group is hidden
-- from list/detail endpoints but past `session_user_shares` rows that
-- reference it can still resolve the group's name + member snapshot
-- for the recipient-pill tooltip.
ALTER TABLE groups
  ADD COLUMN archived_at TIMESTAMPTZ;

-- Membership audit — who added this user, useful for future "who
-- added me to design?" UI affordances. No FK for the same reason as
-- created_by. Nullable so existing rows don't need backfill.
ALTER TABLE group_members
  ADD COLUMN added_by UUID;

-- Name uniqueness scoped to ACTIVE manual groups. Case-insensitive so
-- "Design" and "design" can't both exist. Slug uniqueness from 027
-- remains the authoritative URL identifier; this guards user-visible
-- name collisions in the settings UI.
--
-- Limited to source='manual' on purpose: SCIM groups can theoretically
-- have any name the IdP gives them (incl. duplicates that we'd then
-- want to differentiate by externalId), and dynamic groups are
-- system-named.
CREATE UNIQUE INDEX groups_ws_name_active_manual
  ON groups (workspace_id, lower(name))
  WHERE archived_at IS NULL AND source = 'manual';

-- "Groups created by this user" — supports a future filter; cheap to
-- maintain. Partial so the index is small (most groups will eventually
-- have a creator, but the column is nullable today).
CREATE INDEX groups_created_by
  ON groups (created_by)
  WHERE created_by IS NOT NULL;

-- "Active groups in this workspace" — narrows the most-common scan
-- (list endpoint) to the active subset.
CREATE INDEX groups_workspace_active
  ON groups (workspace_id)
  WHERE archived_at IS NULL;
