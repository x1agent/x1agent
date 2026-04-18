import {
  type Clock,
  type Email,
  type Role,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { InvitationRepository } from "../ports/invitation-repository.js";
import type { WorkspaceReader } from "../ports/workspace-reader.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { TokenGenerator } from "../ports/token-generator.js";
import type { Invitation } from "../domain/invitation.js";
import {
  AlreadyMemberError,
  InvitationAlreadyPendingError,
} from "../domain/errors.js";

export interface SendInvitationDeps {
  invitations: InvitationRepository;
  workspaces: WorkspaceReader;
  adminGuard: AdminGuard;
  tokens: TokenGenerator;
  clock: Clock;
  ttlMs?: number;
}

export interface SendInvitationInput {
  actor: UserId;
  workspaceId: WorkspaceId;
  email: Email;
  role: Role;
}

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export async function sendInvitation(
  deps: SendInvitationDeps,
  input: SendInvitationInput,
): Promise<Invitation> {
  await deps.adminGuard.assertAdmin(input.actor, input.workspaceId);

  const existingUserId = await deps.workspaces.findUserIdByEmail(input.email);
  if (existingUserId) {
    const isMember = await deps.workspaces.isMember(
      existingUserId,
      input.workspaceId,
    );
    if (isMember) throw new AlreadyMemberError();
  }

  const pending = await deps.invitations.findActivePendingForEmail(
    input.workspaceId,
    input.email,
  );
  if (pending) throw new InvitationAlreadyPendingError();

  const now = deps.clock.now();
  return deps.invitations.create({
    workspaceId: input.workspaceId,
    email: input.email,
    role: input.role,
    token: deps.tokens.mint(),
    invitedBy: input.actor,
    expiresAt: new Date(now.getTime() + (deps.ttlMs ?? DEFAULT_TTL_MS)),
  });
}
