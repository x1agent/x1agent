import {
  InvitationId,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
  type Email,
  type Role,
} from "@x1agent/kernel";
import type { InvitationRepository } from "../ports/invitation-repository.js";
import type { WorkspaceReader } from "../ports/workspace-reader.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { MembershipGrantor } from "../ports/membership-grantor.js";
import type { TokenGenerator } from "../ports/token-generator.js";
import {
  InvitationToken,
  type Invitation,
} from "../domain/invitation.js";
import { DomainError } from "@x1agent/kernel";

/** Error used only by DenyAdmin fake — matches AdminGuard's contract of
 *  throwing a DomainError on failure. Not exported from the public API. */
class FakeAdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("admin denied (fake)");
  }
}

let idCounter = 1;
function nextUuid(): string {
  const n = (idCounter++).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export class InMemoryInvitationRepository implements InvitationRepository {
  readonly rows = new Map<string, Invitation>();

  async create(input: {
    workspaceId: WorkspaceId;
    email: Email;
    role: Role;
    token: InvitationToken;
    invitedBy: UserId;
    expiresAt: Date;
  }): Promise<Invitation> {
    const inv: Invitation = {
      id: InvitationId(nextUuid()),
      workspaceId: input.workspaceId,
      email: input.email,
      role: input.role,
      token: input.token,
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      acceptedBy: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.rows.set(inv.id, inv);
    return inv;
  }

  async findById(id: InvitationId): Promise<Invitation | null> {
    return this.rows.get(id) ?? null;
  }

  async findByToken(token: InvitationToken): Promise<Invitation | null> {
    for (const r of this.rows.values()) if (r.token === token) return r;
    return null;
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly Invitation[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
  }

  async findActivePendingForEmail(
    workspaceId: WorkspaceId,
    email: Email,
  ): Promise<Invitation | null> {
    for (const r of this.rows.values()) {
      if (
        r.workspaceId === workspaceId &&
        r.email === email &&
        !r.acceptedAt &&
        !r.revokedAt
      )
        return r;
    }
    return null;
  }

  async markAccepted(id: InvitationId, acceptedBy: UserId, at: Date) {
    const r = this.rows.get(id);
    if (!r) return;
    r.acceptedAt = at;
    r.acceptedBy = acceptedBy;
  }

  async markRevoked(id: InvitationId, at: Date) {
    const r = this.rows.get(id);
    if (!r) return;
    r.revokedAt = at;
  }
}

export class FakeWorkspaceReader implements WorkspaceReader {
  constructor(
    private readonly workspaces: Array<{
      id: WorkspaceId;
      slug: WorkspaceSlug;
      name: string;
    }>,
    private readonly users: Map<string, UserId> = new Map(),
    private readonly memberships: Array<{
      userId: UserId;
      workspaceId: WorkspaceId;
    }> = [],
  ) {}

  async getIdBySlug(slug: WorkspaceSlug): Promise<WorkspaceId | null> {
    return this.workspaces.find((w) => w.slug === slug)?.id ?? null;
  }

  async getNameAndSlug(id: WorkspaceId) {
    const w = this.workspaces.find((x) => x.id === id);
    return w ? { slug: w.slug, name: w.name } : null;
  }

  async isMember(userId: UserId, workspaceId: WorkspaceId) {
    return this.memberships.some(
      (m) => m.userId === userId && m.workspaceId === workspaceId,
    );
  }

  async findUserIdByEmail(email: string) {
    return this.users.get(email.toLowerCase()) ?? null;
  }
}

export class AllowAllAdmin implements AdminGuard {
  async assertAdmin() {
    return;
  }
}

export class DenyAdmin implements AdminGuard {
  async assertAdmin(): Promise<never> {
    throw new FakeAdminDeniedError();
  }
}

export class InMemoryMembershipGrantor implements MembershipGrantor {
  readonly grants: Array<{
    workspaceId: WorkspaceId;
    userId: UserId;
    role: Role;
  }> = [];
  async grant(workspaceId: WorkspaceId, userId: UserId, role: Role) {
    this.grants.push({ workspaceId, userId, role });
  }
}

export class SeqTokenGenerator implements TokenGenerator {
  private n = 0;
  mint(): InvitationToken {
    return InvitationToken(`tok-${++this.n}`);
  }
}
