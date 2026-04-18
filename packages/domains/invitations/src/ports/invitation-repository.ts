import type {
  Email,
  InvitationId,
  Role,
  UserId,
  WorkspaceId,
} from "@x1agent/kernel";
import type { Invitation, InvitationToken } from "../domain/invitation.js";

export interface InvitationRepository {
  create(input: {
    workspaceId: WorkspaceId;
    email: Email;
    role: Role;
    token: InvitationToken;
    invitedBy: UserId;
    expiresAt: Date;
  }): Promise<Invitation>;

  findById(id: InvitationId): Promise<Invitation | null>;
  findByToken(token: InvitationToken): Promise<Invitation | null>;

  listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly Invitation[]>;

  /** Find a still-pending invitation for (workspace, email) lowercase. */
  findActivePendingForEmail(
    workspaceId: WorkspaceId,
    email: Email,
  ): Promise<Invitation | null>;

  markAccepted(
    id: InvitationId,
    acceptedBy: UserId,
    at: Date,
  ): Promise<void>;

  markRevoked(id: InvitationId, at: Date): Promise<void>;
}
