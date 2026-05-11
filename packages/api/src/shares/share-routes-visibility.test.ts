import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
  DomainError,
  type Email,
} from "@x1agent/kernel";
import { AgentId, type Agent } from "@x1agent/domain-agents";
import {
  SessionId,
  SessionShareId,
  type Session,
  type SessionShare,
  type SessionEvent,
} from "@x1agent/domain-sessions";
import { createWorkspaceShareRoutes } from "./routes.js";

/**
 * X1A-9 — fake-based regression for `createWorkspaceShareRoutes`.
 *
 * Covers the visibility matrix on the per-session shares list:
 *
 *   GET /api/workspaces/:slug/sessions/:sessionId/shares
 *
 * Before X1A-9 this route was admin-only — a session owner couldn't
 * list the shares emitted by their own session. The fix routes the
 * scope check through `resolveSessionVisibility`, the same primitive
 * the workspace session detail uses.
 *
 * The full live-DB matrix (including the workspace shares index that
 * uses raw SQL) lives in
 * `packages/api/src/sessions-shares-visibility.integration.test.ts`.
 */

class FakeSessions {
  rows = new Map<string, Session>();
  add(s: Session) {
    this.rows.set(s.id, s);
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
}

class FakeAgents {
  rows = new Map<string, Agent>();
  add(a: Agent) {
    this.rows.set(a.id, a);
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
}

class FakeEvents {
  bySession = new Map<string, SessionEvent[]>();
  add(sessionId: string, ev: SessionEvent) {
    const arr = this.bySession.get(sessionId) ?? [];
    arr.push(ev);
    this.bySession.set(sessionId, arr);
  }
  async listBySession(sessionId: string) {
    return this.bySession.get(sessionId) ?? [];
  }
}

class FakeShares {
  rows: SessionShare[] = [];
  add(sessionId: string, userId: string) {
    this.rows.push({
      id: SessionShareId(`share-${this.rows.length + 1}`),
      sessionId: sessionId as never,
      userId: userId as never,
      role: "viewer",
      sharedBy: "" as never,
      createdAt: new Date(),
    });
  }
  async findForUser(sessionId: string, userId: string) {
    return (
      this.rows.find(
        (r) => r.sessionId === sessionId && r.userId === userId,
      ) ?? null
    );
  }
  async upsert() {
    throw new Error("not used");
  }
  async remove() {}
  async removeForUser() {}
  async listForSession() {
    return [];
  }
  async listForUser() {
    return [];
  }
}

class AdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("not admin");
  }
}

class AdminGuard {
  // Per-workspace admins — critical for cross-workspace tests.
  admins = new Set<string>();
  setAdmin(userId: string, workspaceId: string) {
    this.admins.add(`${userId}:${workspaceId}`);
  }
  async assertAdmin(userId: string, workspaceId: string) {
    if (!this.admins.has(`${userId}:${workspaceId}`))
      throw new AdminDeniedError();
  }
}

const WS_A = WorkspaceId("00000000-0000-7000-8000-0000000000a1");
const WS_B = WorkspaceId("00000000-0000-7000-8000-0000000000b1");
const SLUG_A = WorkspaceSlug("ws-a");
const SLUG_B = WorkspaceSlug("ws-b");

const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const BOB = UserId("00000000-0000-7000-8000-00000000b0b0");
const CAROL = UserId("00000000-0000-7000-8000-00000000ca40");
const DAVE = UserId("00000000-0000-7000-8000-00000000dade");

const AGENT_A = AgentId("00000000-0000-7000-8000-0000000000a0");
const AGENT_B = AgentId("00000000-0000-7000-8000-0000000000b0");
const SESSION_A = SessionId("00000000-0000-7000-8000-000000000001"); // owned by Alice in A
const SESSION_B = SessionId("00000000-0000-7000-8000-000000000002"); // owned by Bob in A — Alice is sharee
const SESSION_C = SessionId("00000000-0000-7000-8000-000000000003"); // owned by Dave in B

function makeAgent(id: AgentId, workspaceId: WorkspaceId): Agent {
  return {
    id,
    workspaceId,
    slug: "agent",
    name: "Agent",
    runtimeType: "claude_code",
    kind: "worker",
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    isActive: true,
    imageId: null,
    model: null,
    ownerUserId: ALICE,
    visibility: "workspace",
    createdBy: ALICE,
    scheduledRunAsUserId: ALICE,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSchedulerTickAt: null,
  } as unknown as Agent;
}

function makeSession(
  id: SessionId,
  agentId: AgentId,
  ownerId: ReturnType<typeof UserId>,
): Session {
  return {
    id,
    agentId,
    triggeredBy: "user",
    triggeredByUserId: ownerId,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: new Date(),
    status: "running",
    completedAt: null,
    errorMessage: null,
    createdAt: new Date(),
    summary: null,
    summaryUpdatedAt: null,
    summaryEventSeq: null,
  } as Session;
}

let sessions: FakeSessions;
let agents: FakeAgents;
let events: FakeEvents;
let shares: FakeShares;
let adminGuard: AdminGuard;
let actor: { userId: ReturnType<typeof UserId>; email: Email };

function build() {
  const routes = createWorkspaceShareRoutes({
    sessions: sessions as never,
    events: events as never,
    agents: agents as never,
    adminGuard: adminGuard as never,
    shares: shares as never,
    resolveWorkspace: async (slug) => {
      if (slug === SLUG_A) return WS_A;
      if (slug === SLUG_B) return WS_B;
      return null;
    },
    requireAuth: async (_c, next) => {
      await next();
    },
    getActor: () => actor,
  });
  const root = new Hono();
  root.route(
    "/api/workspaces/:slug/sessions/:sessionId/shares",
    routes,
  );
  return root;
}

beforeEach(() => {
  sessions = new FakeSessions();
  agents = new FakeAgents();
  events = new FakeEvents();
  shares = new FakeShares();
  adminGuard = new AdminGuard();

  agents.add(makeAgent(AGENT_A, WS_A));
  agents.add(makeAgent(AGENT_B, WS_B));
  sessions.add(makeSession(SESSION_A, AGENT_A, ALICE));
  sessions.add(makeSession(SESSION_B, AGENT_A, BOB));
  sessions.add(makeSession(SESSION_C, AGENT_B, DAVE));

  // Each session emits one agent.share event.
  events.add(SESSION_A, {
    id: "e1" as never,
    sessionId: SESSION_A as never,
    seq: 1,
    type: "agent.share",
    payload: { share_id: "share-a", title: "Alice's share" },
    timestamp: new Date(),
  } as unknown as SessionEvent);
  events.add(SESSION_B, {
    id: "e2" as never,
    sessionId: SESSION_B as never,
    seq: 1,
    type: "agent.share",
    payload: { share_id: "share-b", title: "Bob's share" },
    timestamp: new Date(),
  } as unknown as SessionEvent);
  events.add(SESSION_C, {
    id: "e3" as never,
    sessionId: SESSION_C as never,
    seq: 1,
    type: "agent.share",
    payload: { share_id: "share-c", title: "Dave's share" },
    timestamp: new Date(),
  } as unknown as SessionEvent);

  shares.add(SESSION_B, ALICE); // Alice is sharee on Bob's session.
  adminGuard.setAdmin(CAROL, WS_A);
  adminGuard.setAdmin(DAVE, WS_B);
});

describe("per-session shares list — visibility", () => {
  it("owner can list shares on their own session", async () => {
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares`,
    );
    expect(res.status).toBe(200);
    const { shares: arr } = (await res.json()) as { shares: unknown[] };
    expect(arr).toHaveLength(1);
  });

  it("sharee can list shares on a session shared with them", async () => {
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_B}/shares`,
    );
    expect(res.status).toBe(200);
  });

  it("workspace admin can list shares on any session in the workspace", async () => {
    actor = { userId: CAROL, email: "c@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares`,
    );
    expect(res.status).toBe(200);
  });

  it("non-owner non-admin non-sharee gets 404 on a peer's session", async () => {
    // Pre-X1A-9 this returned 403 (admin-only). The new flow folds
    // forbid-vs-not-found into a single 404 to avoid leaking the
    // session id existence to non-members.
    actor = { userId: BOB, email: "b@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares`,
    );
    expect(res.status).toBe(404);
  });

  it("cross-workspace: admin of B gets 404 on a session in A", async () => {
    // Even though Dave is admin in WS_B, the agent for SESSION_A is in
    // WS_A — the visibility check fails and the route collapses to a
    // not-found.
    actor = { userId: DAVE, email: "d@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares`,
    );
    expect(res.status).toBe(404);
  });

  it("cross-workspace: session id from B is invisible via A's URL", async () => {
    actor = { userId: CAROL, email: "c@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_C}/shares`,
    );
    expect(res.status).toBe(404);
  });
});
