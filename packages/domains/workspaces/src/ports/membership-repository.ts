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
   * Every member of a workspace. Used by UI surfaces that need to
   * present a member picker (e.g. agent edit's "Run as" select for
   * scheduled-run-as-user-id). Caller is responsible for joining
   * users to enrich with email/name — this port returns memberships
   * only.
   */
  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly Membership[]>;

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
