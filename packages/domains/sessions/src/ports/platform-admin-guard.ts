import type { UserId } from "@x1agent/kernel";

/**
 * Whether a user is a *platform* admin — the deployment-wide tier that
 * spans every workspace. This is distinct from `AdminGuard` (which
 * gates workspace-admin-only management actions inside one workspace).
 *
 * Why a separate port: a workspace admin should NOT be able to read
 * every user's sessions inside their workspace. That role is for
 * editing agents, settings, and members within the workspace.
 * Cross-user session visibility is a platform-tier decision: only a
 * platform admin (operator of the install) bypasses the per-user
 * filter on session/share list and read endpoints.
 *
 * Implementations typically resolve membership by comparing the
 * caller's email to the `platformAdmins` list configured at install
 * time.
 */
export interface PlatformAdminGuard {
  isPlatformAdmin(userId: UserId): Promise<boolean>;
}
