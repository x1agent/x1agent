import type postgres from "postgres";
import {
  Role,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
  type Role as TRole,
} from "@x1agent/kernel";
import type { Membership } from "../../domain/membership.js";
import type { MembershipRepository } from "../../ports/membership-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  workspace_id: string;
  user_id: string;
  role: string;
  added_at: Date | string;
}

function toMembership(r: Row): Membership {
  return {
    workspaceId: WorkspaceId(r.workspace_id),
    userId: UserId(r.user_id),
    role: Role(r.role),
    addedAt: new Date(r.added_at),
  };
}

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly sql: Sql) {}

  async findByUserAndWorkspace(
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<Membership | null> {
    const rows = await this.sql<Row[]>`
      SELECT workspace_id, user_id, role, added_at
      FROM workspace_members
      WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
    `;
    return rows[0] ? toMembership(rows[0]) : null;
  }

  async findByUserAndSlug(
    userId: UserId,
    slug: WorkspaceSlug,
  ): Promise<Membership | null> {
    const rows = await this.sql<Row[]>`
      SELECT wm.workspace_id, wm.user_id, wm.role, wm.added_at
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${userId} AND w.slug = ${slug}
    `;
    return rows[0] ? toMembership(rows[0]) : null;
  }

  async listByUser(userId: UserId): Promise<readonly Membership[]> {
    const rows = await this.sql<Row[]>`
      SELECT workspace_id, user_id, role, added_at
      FROM workspace_members WHERE user_id = ${userId}
    `;
    return rows.map(toMembership);
  }

  async grant(input: {
    workspaceId: WorkspaceId;
    userId: UserId;
    role: TRole;
  }): Promise<Membership> {
    const rows = await this.sql<Row[]>`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${input.workspaceId}, ${input.userId}, ${input.role})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING workspace_id, user_id, role, added_at
    `;
    return toMembership(rows[0]!);
  }

  async revoke(userId: UserId, workspaceId: WorkspaceId): Promise<void> {
    await this.sql`
      DELETE FROM workspace_members
      WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
    `;
  }
}
