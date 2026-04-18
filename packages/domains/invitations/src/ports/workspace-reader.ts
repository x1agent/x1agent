import type {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";

/**
 * Narrow view of the workspaces domain used by invitations. The
 * composition root satisfies this by delegating to the workspaces
 * adapter — invitations never touches workspaces tables directly.
 */
export interface WorkspaceReader {
  getIdBySlug(slug: WorkspaceSlug): Promise<WorkspaceId | null>;

  getNameAndSlug(
    id: WorkspaceId,
  ): Promise<{ slug: WorkspaceSlug; name: string } | null>;

  /** True when `userId` already has any membership in `workspaceId`. */
  isMember(userId: UserId, workspaceId: WorkspaceId): Promise<boolean>;

  /** Find the user id for an email, or null. Used to detect already-member. */
  findUserIdByEmail(email: string): Promise<UserId | null>;
}
