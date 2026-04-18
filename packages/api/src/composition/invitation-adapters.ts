import type postgres from "postgres";
import {
  DomainError,
  Email,
  WorkspaceSlug,
  type Role,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  type MembershipRepository,
  type WorkspaceRepository,
  assertRoleForSlug,
  InsufficientRoleError,
  NotAMemberError,
} from "@x1agent/domain-workspaces";
import type {
  AdminGuard,
  MembershipGrantor,
  WorkspaceReader,
} from "@x1agent/domain-invitations";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * AdminGuard backed by the workspaces MembershipRepository. The platform
 * uses workspace-role-admin as the threshold for member management.
 */
export class WorkspaceAdminGuard implements AdminGuard {
  constructor(private readonly memberships: MembershipRepository) {}

  async assertAdmin(
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<void> {
    // We don't have slug in hand, so look up directly by workspaceId.
    const m = await this.memberships.findByUserAndWorkspace(
      userId,
      workspaceId,
    );
    if (!m) throw new NotAMemberError(userId, workspaceId);
    if (m.role !== "admin" && m.role !== "owner") {
      throw new InsufficientRoleError(m.role, "admin");
    }
  }
}

export class WorkspaceReaderAdapter implements WorkspaceReader {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sql: Sql,
  ) {}

  async getIdBySlug(slug: WorkspaceSlug) {
    const w = await this.workspaces.findBySlug(slug);
    return w?.id ?? null;
  }

  async getNameAndSlug(id: WorkspaceId) {
    const w = await this.workspaces.findById(id);
    return w ? { slug: w.slug, name: w.name } : null;
  }

  async isMember(userId: UserId, workspaceId: WorkspaceId) {
    const rows = await this.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM workspace_members
      WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
    `;
    return Number(rows[0]?.count ?? "0") > 0;
  }

  async findUserIdByEmail(email: string): Promise<UserId | null> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()}
    `;
    if (!rows[0]) return null;
    // UserId is a branded string; we trust the DB's UUID here rather than
    // re-parse via the kernel constructor.
    return rows[0].id as unknown as UserId;
  }
}

export class MembershipGrantorAdapter implements MembershipGrantor {
  constructor(private readonly memberships: MembershipRepository) {}
  async grant(
    workspaceId: WorkspaceId,
    userId: UserId,
    role: Role,
  ): Promise<void> {
    await this.memberships.grant({ workspaceId, userId, role });
  }
}
