import { DomainError, type UserId, type WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import {
  GrantId,
  type Grant,
  type GrantSubject,
} from "../domain/grant.js";
import type {
  CreateGrantInput,
  ListActiveQuery,
  ListQuery,
  PermissionGrantRepository,
} from "../ports/permission-grant-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";

let counter = 0x100;
function nextId(): string {
  const n = (++counter).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

function subjectMatches(a: GrantSubject, b: GrantSubject): boolean {
  if (a.kind === "user" && b.kind === "user") return a.userId === b.userId;
  if (a.kind === "agent" && b.kind === "agent")
    return a.agentId === b.agentId;
  return false;
}

export class InMemoryPermissionGrantRepository
  implements PermissionGrantRepository
{
  readonly rows: Grant[] = [];

  async create(input: CreateGrantInput): Promise<Grant> {
    const grant: Grant = {
      id: GrantId(nextId()),
      workspaceId: input.workspaceId,
      subject: input.subject,
      grantType: input.grantType,
      details: input.details,
      scope: input.scope,
      sessionId: input.sessionId,
      consumedAt: null,
      revokedAt: null,
      grantedByUserId: input.grantedByUserId,
      grantedAt: new Date(),
      reason: input.reason,
    };
    this.rows.push(grant);
    return grant;
  }

  async findById(id: GrantId): Promise<Grant | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async list(q: ListQuery): Promise<readonly Grant[]> {
    return this.rows
      .filter((r) => r.workspaceId === q.workspaceId)
      .filter((r) => (q.subject ? subjectMatches(r.subject, q.subject) : true))
      .filter((r) => (q.grantType ? r.grantType === q.grantType : true))
      .filter((r) => (q.includeRevoked ? true : r.revokedAt === null))
      .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime());
  }

  async listActive(q: ListActiveQuery): Promise<readonly Grant[]> {
    return this.rows.filter(
      (r) =>
        r.workspaceId === q.workspaceId &&
        subjectMatches(r.subject, q.subject) &&
        r.grantType === q.grantType &&
        r.consumedAt === null &&
        r.revokedAt === null,
    );
  }

  async consumeIfActive(id: GrantId): Promise<Grant | null> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i === -1) return null;
    const r = this.rows[i]!;
    if (r.consumedAt !== null || r.revokedAt !== null) return null;
    const updated: Grant = { ...r, consumedAt: new Date() };
    this.rows[i] = updated;
    return updated;
  }

  async revoke(id: GrantId): Promise<Grant | null> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i === -1) return null;
    const r = this.rows[i]!;
    if (r.revokedAt !== null) return r;
    const updated: Grant = { ...r, revokedAt: new Date() };
    this.rows[i] = updated;
    return updated;
  }
}

class FakeAdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("admin denied (fake)");
  }
}

export class AllowAllAdmin implements AdminGuard {
  async assertAdmin(): Promise<void> {
    return;
  }
}

export class DenyAdmin implements AdminGuard {
  async assertAdmin(): Promise<never> {
    throw new FakeAdminDeniedError();
  }
}

/** Convenience builders used only by tests. */
export function userSubject(u: UserId): GrantSubject {
  return { kind: "user", userId: u };
}
export function agentSubject(a: AgentId): GrantSubject {
  return { kind: "agent", agentId: a };
}
export type { WorkspaceId };
