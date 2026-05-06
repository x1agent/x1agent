import { DomainError, type UserId, type WorkspaceSlug } from "@x1agent/kernel";
import type { WorkspaceRepository } from "../ports/workspace-repository.js";
import type { MembershipRepository } from "../ports/membership-repository.js";
import {
  parseWorkspaceSettingsPatch,
  type WorkspaceSettings,
} from "../domain/workspace-settings.js";
import type { Workspace } from "../domain/workspace.js";
import { assertRoleForSlug } from "./assert-role-for-slug.js";

export class WorkspaceNotFoundError extends DomainError {
  readonly code = "workspace_not_found";
  constructor(slug: WorkspaceSlug) {
    super(`workspace not found: ${slug}`);
  }
}

export interface UpdateWorkspaceSettingsDeps {
  workspaces: WorkspaceRepository;
  memberships: MembershipRepository;
}

/**
 * Update workspace settings. Admin-only. Patch is whitelisted at the
 * domain layer (`parseWorkspaceSettingsPatch`) so a malicious or
 * stale client can't write keys that the domain doesn't know about.
 * Returns the post-merge workspace so the route can echo it back.
 */
export async function updateWorkspaceSettings(
  deps: UpdateWorkspaceSettingsDeps,
  actorUserId: UserId,
  slug: WorkspaceSlug,
  rawPatch: unknown,
): Promise<Workspace> {
  // Admin-or-owner gate. Reuses the same path workspace settings UI
  // is gated by — keeps "who can read" and "who can write" symmetric
  // up to the role boundary.
  await assertRoleForSlug(deps.memberships, actorUserId, slug, "admin");

  const patch: Partial<WorkspaceSettings> = parseWorkspaceSettingsPatch(rawPatch);

  const ws = await deps.workspaces.findBySlug(slug);
  if (!ws) throw new WorkspaceNotFoundError(slug);

  // Empty patch = no-op. Return current state so callers don't
  // accidentally trigger a write on every save.
  if (Object.keys(patch).length === 0) return ws;

  const updated = await deps.workspaces.updateSettings(ws.id, patch);
  if (!updated) throw new WorkspaceNotFoundError(slug);
  return updated;
}
