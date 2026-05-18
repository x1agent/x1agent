import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  Group,
  GroupId,
  GroupSource,
  GroupMembership,
} from "../domain/group.js";

export interface CreateGroupInput {
  workspaceId: WorkspaceId;
  slug: string;
  name: string;
  /** X1A-107 — optional human description. */
  description?: string | null;
  source?: GroupSource;
  externalId?: string;
  rule?: Record<string, unknown>;
  /** X1A-107 — creator userId; nullable for system-created rows (SCIM/dynamic). */
  createdBy?: UserId | null;
}

/** X1A-107 — partial-update payload. Only set fields are applied. */
export interface UpdateGroupInput {
  name?: string;
  description?: string | null;
}

/** X1A-107 — list shape that includes the cheap member-count rollup. */
export interface GroupListEntry extends Group {
  memberCount: number;
}

/** X1A-107 — member row with the audit pointer. */
export interface GroupMemberEntry extends GroupMembership {}

export interface GroupRepository {
  create(input: CreateGroupInput): Promise<Group>;
  findById(id: GroupId): Promise<Group | null>;
  /**
   * X1A-107 — finds by id and asserts active + workspace scope in one
   * round-trip. Returns null on miss, archived, or wrong workspace —
   * routes layer maps to 404 (we don't leak archived vs missing).
   */
  findActiveInWorkspace(
    id: GroupId,
    workspaceId: WorkspaceId,
  ): Promise<Group | null>;
  findBySlug(workspaceId: WorkspaceId, slug: string): Promise<Group | null>;
  /**
   * X1A-107 — finds an ACTIVE manual group by case-insensitive name
   * within a workspace. Used for duplicate-name detection on create.
   */
  findActiveByName(
    workspaceId: WorkspaceId,
    name: string,
  ): Promise<Group | null>;
  /**
   * X1A-107 — lists ACTIVE groups in a workspace plus their member
   * count. Archived rows are excluded. Sorted by name ASC.
   */
  listActiveByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly GroupListEntry[]>;
  /**
   * Legacy — list ALL groups (including archived, all sources). Kept
   * for the grants-resolver path; new code should prefer
   * listActiveByWorkspace.
   */
  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly Group[]>;
  /** X1A-107 — partial update of name / description. */
  update(id: GroupId, input: UpdateGroupInput): Promise<Group>;
  /**
   * Legacy alias preserved for the grants-flow caller that touches
   * only the name field. New code should use `update`.
   */
  updateName(id: GroupId, name: string): Promise<Group>;
  /**
   * X1A-107 — soft delete (sets archived_at = now). Idempotent: a
   * second call on an already-archived row is a no-op.
   */
  archive(id: GroupId): Promise<void>;
  /**
   * Legacy hard-delete. Retained so the grants resolver / sync jobs
   * can purge SCIM-source rows that vanish upstream. Manual-source
   * routes should call `archive` instead.
   */
  delete(id: GroupId): Promise<void>;

  // Membership
  /**
   * X1A-107 — adds a single user; idempotent (ON CONFLICT DO NOTHING).
   * `addedBy` is recorded for audit purposes; null = system-added
   * (SCIM/dynamic), non-null = workspace member who triggered the add.
   */
  addMember(
    id: GroupId,
    userId: UserId,
    addedBy?: UserId | null,
  ): Promise<void>;
  /**
   * X1A-107 — bulk add. Returns the count of rows actually inserted
   * (i.e. excludes already-members). Idempotent.
   */
  addMembers(
    id: GroupId,
    userIds: readonly UserId[],
    addedBy?: UserId | null,
  ): Promise<number>;
  removeMember(id: GroupId, userId: UserId): Promise<void>;
  listMembers(id: GroupId): Promise<readonly UserId[]>;
  /**
   * X1A-107 — like listMembers but returns the full membership row
   * (addedAt, addedBy). Used by the group-detail endpoint.
   */
  listMemberships(id: GroupId): Promise<readonly GroupMemberEntry[]>;
  /**
   * "What manual + scim groups is this user in (within this workspace)?"
   * Used by the access resolver to expand subject_kind='group' grants.
   * Dynamic groups are NOT returned here — the caller evaluates rules
   * separately if/when dynamic groups are introduced.
   *
   * X1A-107 — archived groups are excluded; their resolution-at-share-
   * time grant is replayed from the share row's snapshot, not from
   * live membership (see X1A-109).
   */
  listGroupIdsForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<readonly GroupId[]>;
  /**
   * X1A-107 — "what active groups in this workspace is this user in"
   * with full Group rows, sorted by name. Powers `GET
   * /api/workspaces/:slug/groups/memberships` for the UI's "you're in:
   * design, on-call" affordance.
   */
  listGroupsForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<readonly Group[]>;
}
