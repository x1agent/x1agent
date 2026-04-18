import type postgres from "postgres";
import {
  Email,
  InvitationId,
  Role,
  UserId,
  WorkspaceId,
} from "@x1agent/kernel";
import type { InvitationRepository } from "../../ports/invitation-repository.js";
import {
  InvitationToken,
  type Invitation,
} from "../../domain/invitation.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  token: string;
  invited_by: string | null;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  accepted_by: string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

function toInvitation(r: Row): Invitation {
  return {
    id: InvitationId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    email: Email(r.email),
    role: Role(r.role),
    token: InvitationToken(r.token),
    invitedBy: r.invited_by ? UserId(r.invited_by) : null,
    expiresAt: new Date(r.expires_at),
    acceptedAt: r.accepted_at ? new Date(r.accepted_at) : null,
    acceptedBy: r.accepted_by ? UserId(r.accepted_by) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
    createdAt: new Date(r.created_at),
  };
}

export class PostgresInvitationRepository implements InvitationRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: {
    workspaceId: WorkspaceId;
    email: Email;
    role: Role;
    token: InvitationToken;
    invitedBy: UserId;
    expiresAt: Date;
  }): Promise<Invitation> {
    const rows = await this.sql<Row[]>`
      INSERT INTO invitations (workspace_id, email, role, token, invited_by, expires_at)
      VALUES (${input.workspaceId}, ${input.email}, ${input.role},
              ${input.token}, ${input.invitedBy}, ${input.expiresAt})
      RETURNING id, workspace_id, email, role, token, invited_by,
                expires_at, accepted_at, accepted_by, revoked_at, created_at
    `;
    return toInvitation(rows[0]!);
  }

  async findById(id: InvitationId): Promise<Invitation | null> {
    const rows = await this.sql<Row[]>`
      SELECT id, workspace_id, email, role, token, invited_by,
             expires_at, accepted_at, accepted_by, revoked_at, created_at
      FROM invitations WHERE id = ${id}
    `;
    return rows[0] ? toInvitation(rows[0]) : null;
  }

  async findByToken(token: InvitationToken): Promise<Invitation | null> {
    const rows = await this.sql<Row[]>`
      SELECT id, workspace_id, email, role, token, invited_by,
             expires_at, accepted_at, accepted_by, revoked_at, created_at
      FROM invitations WHERE token = ${token}
    `;
    return rows[0] ? toInvitation(rows[0]) : null;
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly Invitation[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, workspace_id, email, role, token, invited_by,
             expires_at, accepted_at, accepted_by, revoked_at, created_at
      FROM invitations WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
    return rows.map(toInvitation);
  }

  async findActivePendingForEmail(
    workspaceId: WorkspaceId,
    email: Email,
  ): Promise<Invitation | null> {
    const rows = await this.sql<Row[]>`
      SELECT id, workspace_id, email, role, token, invited_by,
             expires_at, accepted_at, accepted_by, revoked_at, created_at
      FROM invitations
      WHERE workspace_id = ${workspaceId}
        AND lower(email) = ${email}
        AND accepted_at IS NULL
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return rows[0] ? toInvitation(rows[0]) : null;
  }

  async markAccepted(
    id: InvitationId,
    acceptedBy: UserId,
    at: Date,
  ): Promise<void> {
    await this.sql`
      UPDATE invitations
         SET accepted_at = ${at}, accepted_by = ${acceptedBy}
       WHERE id = ${id}
    `;
  }

  async markRevoked(id: InvitationId, at: Date): Promise<void> {
    await this.sql`
      UPDATE invitations SET revoked_at = ${at} WHERE id = ${id}
    `;
  }
}
