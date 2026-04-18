import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Pluggable role check. The invitations domain doesn't care how "admin"
 * is resolved (RBAC, ACLs, platform admin override) — the composition
 * root wires this to the workspaces domain's `assertRoleForSlug` or an
 * equivalent policy.
 *
 * Should throw a domain error (NotAMemberError, InsufficientRoleError)
 * on failure. Returns void on success.
 */
export interface AdminGuard {
  assertAdmin(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}
