import { DomainError } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import type {
  CreateSessionInput,
  SessionRepository,
  UpdateSessionStatusInput,
} from "../ports/session-repository.js";
import type {
  AppendSessionEventInput,
  SessionEventRepository,
} from "../ports/session-event-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import {
  SessionDuplicateTickError,
  SessionId,
  SessionNotFoundError,
  type Session,
} from "../domain/session.js";
import {
  SessionEventDuplicateError,
  SessionEventId,
  type SessionEvent,
} from "../domain/event.js";

let counter = 0x40;
function nextId(): string {
  const n = (++counter).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export class InMemorySessionRepository implements SessionRepository {
  readonly rows: Session[] = [];

  async create(input: CreateSessionInput): Promise<Session> {
    const clash = this.rows.find(
      (r) =>
        r.agentId === input.agentId &&
        r.triggeredAt.getTime() === input.triggeredAt.getTime(),
    );
    if (clash)
      throw new SessionDuplicateTickError(input.agentId, input.triggeredAt);
    const session: Session = {
      id: SessionId(nextId()),
      agentId: input.agentId,
      triggeredBy: input.triggeredBy,
      triggeredByUserId: input.triggeredByUserId,
      parentSessionId: input.parentSessionId,
      parentAgentId: input.parentAgentId,
      resumedFromSessionId: input.resumedFromSessionId,
      triggeredAt: input.triggeredAt,
      status: "pending",
      completedAt: null,
      errorMessage: null,
      createdAt: new Date(),
    };
    this.rows.push(session);
    return session;
  }

  async findById(id: SessionId): Promise<Session | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async listByAgent(
    agentId: AgentId,
    limit: number,
  ): Promise<readonly Session[]> {
    return this.rows
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime())
      .slice(0, limit);
  }

  async listByWorkspace(
    _workspaceId: unknown,
    limit: number,
  ): Promise<readonly Session[]> {
    // The fake doesn't track workspace → agent joins because agents
    // live in a separate in-memory repo. Callers that need workspace
    // scoping should seed only sessions for the relevant agents and
    // rely on the natural chronological sort below.
    return this.rows
      .slice()
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime())
      .slice(0, limit);
  }

  async listChildren(parentSessionId: SessionId): Promise<readonly Session[]> {
    return this.rows
      .filter((r) => r.parentSessionId === parentSessionId)
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());
  }

  async lastSchedulerRunFor(agentId: AgentId): Promise<Session | null> {
    const scoped = this.rows
      .filter((r) => r.agentId === agentId && r.triggeredBy === "scheduler")
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());
    return scoped[0] ?? null;
  }

  async findLiveSessionForAgent(agentId: AgentId): Promise<Session | null> {
    const scoped = this.rows
      .filter(
        (r) =>
          r.agentId === agentId &&
          (r.status === "pending" || r.status === "running"),
      )
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());
    return scoped[0] ?? null;
  }

  async updateStatus(
    id: SessionId,
    patch: UpdateSessionStatusInput,
  ): Promise<Session> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i === -1) throw new SessionNotFoundError(id);
    const cur = this.rows[i]!;
    const updated: Session = {
      ...cur,
      status: patch.status,
      completedAt:
        patch.completedAt === undefined ? cur.completedAt : patch.completedAt,
      errorMessage:
        patch.errorMessage === undefined
          ? cur.errorMessage
          : patch.errorMessage,
    };
    this.rows[i] = updated;
    return updated;
  }

  async listNonTerminalOlderThan(
    threshold: Date,
  ): Promise<readonly Session[]> {
    return this.rows
      .filter(
        (r) =>
          (r.status === "pending" || r.status === "running") &&
          r.triggeredAt < threshold,
      )
      .sort((a, b) => a.triggeredAt.getTime() - b.triggeredAt.getTime());
  }
}

class FakeAdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("admin denied (fake)");
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

let eventCounter = 0x80;
function nextEventId(): string {
  const n = (++eventCounter).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export class InMemorySessionEventRepository
  implements SessionEventRepository
{
  readonly rows: SessionEvent[] = [];

  async append(input: AppendSessionEventInput): Promise<SessionEvent> {
    const clash = this.rows.find(
      (r) => r.sessionId === input.sessionId && r.seq === input.seq,
    );
    if (clash)
      throw new SessionEventDuplicateError(input.sessionId, input.seq);
    const ev: SessionEvent = {
      id: SessionEventId(nextEventId()),
      sessionId: input.sessionId,
      seq: input.seq,
      type: input.type,
      payload: input.payload,
      timestamp: input.timestamp,
      createdAt: new Date(),
    };
    this.rows.push(ev);
    return ev;
  }

  async listBySession(
    sessionId: SessionId,
    opts: { afterSeq?: number; limit?: number } = {},
  ): Promise<readonly SessionEvent[]> {
    const after = opts.afterSeq ?? -1;
    const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));
    return this.rows
      .filter((r) => r.sessionId === sessionId && r.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }
}
