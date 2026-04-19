import { DomainError } from "@x1agent/kernel";
import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { SessionId } from "@x1agent/domain-sessions";
import { validateGrantDetails } from "../domain/details/registry.js";
import type {
  Grant,
  GrantScope,
  GrantSubject,
  GrantType,
} from "../domain/grant.js";
import type { PermissionGrantRepository } from "../ports/permission-grant-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";

class SessionScopeRequiresSessionError extends DomainError {
  readonly code = "session_scope_requires_session_id";
  constructor() {
    super("scope='session' requires session_id");
  }
}

class NonSessionScopeRejectsSessionError extends DomainError {
  readonly code = "non_session_scope_rejects_session_id";
  constructor() {
    super("scope='once' and 'persistent' do not accept session_id");
  }
}

export interface CreateGrantCommand {
  actor: UserId;
  workspaceId: WorkspaceId;
  subject: GrantSubject;
  grantType: GrantType;
  details: unknown;
  scope: GrantScope;
  sessionId: SessionId | null;
  reason: string | null;
}

export interface CreateGrantDeps {
  grants: PermissionGrantRepository;
  adminGuard: AdminGuard;
}

/**
 * The single write path for a grant. Admin-gated: only humans create
 * grants, and only admins of the target workspace. The application
 * layer validates `details` against the registered shape for
 * `grant_type` before it touches the repo.
 */
export async function createGrant(
  deps: CreateGrantDeps,
  cmd: CreateGrantCommand,
): Promise<Grant> {
  await deps.adminGuard.assertAdmin(cmd.actor, cmd.workspaceId);

  if (cmd.scope === "session" && !cmd.sessionId)
    throw new SessionScopeRequiresSessionError();
  if (cmd.scope !== "session" && cmd.sessionId)
    throw new NonSessionScopeRejectsSessionError();

  const details = validateGrantDetails(cmd.grantType, cmd.details);

  return deps.grants.create({
    workspaceId: cmd.workspaceId,
    subject: cmd.subject,
    grantType: cmd.grantType,
    details,
    scope: cmd.scope,
    sessionId: cmd.sessionId,
    grantedByUserId: cmd.actor,
    reason: cmd.reason,
  });
}
