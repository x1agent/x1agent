import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { Group, GroupId, GroupSource } from "../domain/group.js";

export interface CreateGroupInput {
  workspaceId: WorkspaceId;
  slug: string;
  name: string;
  source?: GroupSource;
  externalId?: string;
  rule?: Record<string, unknown>;
}

export interface GroupRepository {
  create(input: CreateGroupInput): Promise<Group>;
  findById(id: GroupId): Promise<Group | null>;
  findBySlug(workspaceId: WorkspaceId, slug: string): Promise<Group | null>;
  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly Group[]>;
  updateName(id: GroupId, name: string): Promise<Group>;
  delete(id: GroupId): Promise<void>;

  // Membership
  addMember(id: GroupId, userId: UserId): Promise<void>;
  removeMember(id: GroupId, userId: UserId): Promise<void>;
  listMembers(id: GroupId): Promise<readonly UserId[]>;
  /**
   * "What manual + scim groups is this user in (within this workspace)?"
   * Used by the access resolver to expand subject_kind='group' grants.
   * Dynamic groups are NOT returned here — the caller evaluates rules
   * separately if/when dynamic groups are introduced.
   */
  listGroupIdsForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<readonly GroupId[]>;
}
