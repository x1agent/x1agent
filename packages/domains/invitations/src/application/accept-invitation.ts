import type { Clock, Email, UserId } from "@x1agent/kernel";
import type { InvitationRepository } from "../ports/invitation-repository.js";
import type { WorkspaceReader } from "../ports/workspace-reader.js";
import type { MembershipGrantor } from "../ports/membership-grantor.js";
import type {
  Invitation,
  InvitationToken,
} from "../domain/invitation.js";
import { canAccept } from "../domain/invitation.js";
import { InvitationNotFoundError } from "../domain/errors.js";

export interface AcceptInvitationDeps {
  invitations: InvitationRepository;
  workspaces: WorkspaceReader;
  memberships: MembershipGrantor;
  clock: Clock;
}

export interface AcceptInvitationInput {
  acceptor: UserId;
  acceptorEmail: Email;
  token: InvitationToken;
}

export interface AcceptInvitationResult {
  invitation: Invitation;
  workspaceSlug: string;
}

export async function acceptInvitation(
  deps: AcceptInvitationDeps,
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  const inv = await deps.invitations.findByToken(input.token);
  if (!inv) throw new InvitationNotFoundError();

  const now = deps.clock.now();
  canAccept(inv, input.acceptorEmail, now);

  await deps.memberships.grant(inv.workspaceId, input.acceptor, inv.role);
  await deps.invitations.markAccepted(inv.id, input.acceptor, now);

  const ws = await deps.workspaces.getNameAndSlug(inv.workspaceId);
  if (!ws) throw new InvitationNotFoundError();

  return { invitation: inv, workspaceSlug: ws.slug };
}
