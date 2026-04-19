import type { UserId } from "@x1agent/kernel";
import type { Grant } from "../domain/grant.js";
import type {
  ListQuery,
  PermissionGrantRepository,
} from "../ports/permission-grant-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";

export interface ListGrantsDeps {
  grants: PermissionGrantRepository;
  adminGuard: AdminGuard;
}

export interface ListGrantsCommand extends ListQuery {
  actor: UserId;
}

export async function listGrants(
  deps: ListGrantsDeps,
  cmd: ListGrantsCommand,
): Promise<readonly Grant[]> {
  await deps.adminGuard.assertAdmin(cmd.actor, cmd.workspaceId);
  return deps.grants.list({
    workspaceId: cmd.workspaceId,
    subject: cmd.subject,
    grantType: cmd.grantType,
    includeRevoked: cmd.includeRevoked,
  });
}
