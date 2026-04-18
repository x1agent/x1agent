import type {
  Role,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { Membership } from "../domain/membership.js";

export interface MembershipRepository {
  findByUserAndWorkspace(
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<Membership | null>;

  findByUserAndSlug(
    userId: UserId,
    slug: WorkspaceSlug,
  ): Promise<Membership | null>;

  listByUser(userId: UserId): Promise<readonly Membership[]>;

  /**
   * Upserts (workspaceId, userId). If the user is already a member, the
   * role is updated to the requested value. Idempotent.
   */
  grant(input: {
    workspaceId: WorkspaceId;
    userId: UserId;
    role: Role;
  }): Promise<Membership>;

  /** Remove a user from a workspace. No-op if absent. */
  revoke(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}
