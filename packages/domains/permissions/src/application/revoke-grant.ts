import type { UserId, WorkspaceId } from "@x1agent/kernel";
import { GrantNotFoundError, type Grant, type GrantId } from "../domain/grant.js";
import type { PermissionGrantRepository } from "../ports/permission-grant-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import { DomainError } from "@x1agent/kernel";

class GrantWrongWorkspaceError extends DomainError {
  readonly code = "grant_wrong_workspace";
  constructor() {
    super("grant does not belong to this workspace");
  }
}

export interface RevokeGrantCommand {
  actor: UserId;
  workspaceId: WorkspaceId;
  grantId: GrantId;
}

export interface RevokeGrantDeps {
  grants: PermissionGrantRepository;
  adminGuard: AdminGuard;
}

/**
 * Soft-delete a grant. Idempotent: revoking an already-revoked grant is
 * a no-op. Admins of the workspace only; cross-workspace revocation is
 * rejected even for platform admins (grants are a workspace-scoped
 * resource).
 */
export async function revokeGrant(
  deps: RevokeGrantDeps,
  cmd: RevokeGrantCommand,
): Promise<Grant> {
  await deps.adminGuard.assertAdmin(cmd.actor, cmd.workspaceId);

  const existing = await deps.grants.findById(cmd.grantId);
  if (!existing) throw new GrantNotFoundError(cmd.grantId);
  if (existing.workspaceId !== cmd.workspaceId)
    throw new GrantWrongWorkspaceError();

  if (existing.revokedAt) return existing;
  const revoked = await deps.grants.revoke(cmd.grantId);
  if (!revoked) throw new GrantNotFoundError(cmd.grantId);
  return revoked;
}
