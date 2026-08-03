import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { MembershipRepository, WorkspaceRepository } from "@x1agent/domain-workspaces";
import type { AdministrativeMcpInstallationGate } from "../ports/installation-gate.js";

export type AdministrativeMcpWorkspaceAccess =
  | { allowed: true; workspaceId: WorkspaceId; role: "member" | "admin" | "owner" }
  | { allowed: false; reason: "feature_disabled" | "workspace_mcp_disabled" | "not_found" };

export interface WorkspaceAccessDependencies {
  installationGate: AdministrativeMcpInstallationGate;
  workspaces: WorkspaceRepository;
  memberships: MembershipRepository;
}

/**
 * Resolves the live, non-token authorization portion of administrative MCP
 * access. Call this on every tool request: membership and workspace
 * enablement changes take effect without waiting for a token to expire.
 */
export async function resolveAdministrativeMcpWorkspaceAccess(
  deps: WorkspaceAccessDependencies,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<AdministrativeMcpWorkspaceAccess> {
  if (!(await deps.installationGate.isEnabled())) {
    return { allowed: false, reason: "feature_disabled" };
  }
  const workspace = await deps.workspaces.findById(workspaceId);
  if (!workspace) return { allowed: false, reason: "not_found" };
  if (!workspace.settings.administrativeMcpEnabled) {
    return { allowed: false, reason: "workspace_mcp_disabled" };
  }
  const membership = await deps.memberships.findByUserAndWorkspace(userId, workspaceId);
  if (!membership) return { allowed: false, reason: "not_found" };
  return { allowed: true, workspaceId, role: membership.role };
}

/** Lists only currently enabled workspaces the caller is currently a member of. */
export async function listAdministrativeMcpWorkspaces(
  deps: WorkspaceAccessDependencies,
  userId: UserId,
) {
  if (!(await deps.installationGate.isEnabled())) return [];
  const memberships = await deps.memberships.listByUser(userId);
  const results = await Promise.all(
    memberships.map(async (membership) => {
      const workspace = await deps.workspaces.findById(membership.workspaceId);
      return workspace?.settings.administrativeMcpEnabled
        ? { workspace, role: membership.role }
        : null;
    }),
  );
  return results.filter((result): result is NonNullable<typeof result> => result !== null);
}
