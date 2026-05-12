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
import { SessionId, type Session } from "../../domain/session.js";
import {
  SessionShareId,
  type SessionShare,
} from "../../domain/share.js";
import { createWorkspaceSessionRoutes } from "./routes.js";

/**
 * X1A-9 — fake-based regression for `createWorkspaceSessionRoutes`.
 *
 * Covers the visibility matrix for two surfaces:
 *
 *   GET /api/workspaces/:slug/sessions           — list
 *   GET /api/workspaces/:slug/sessions/:id       — detail
 *
 * The full live-DB matrix lives in
 * `packages/api/src/sessions-shares-visibility.integration.test.ts`.
 * This file gives us coverage that runs in any sandbox + locks down the
 * `loadScoped` / `pickSessionListMode` wiring without Postgres.
 */

class FakeSessions {
  rows: Session[] = [];
  shareRows: { sessionId: string; userId: string }[] = [];
  add(s: Session) {
    this.rows.push(s);
  }
  share(sessionId: string, userId: string) {
    this.shareRows.push({ sessionId, userId });
  }
  async findById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async listByWorkspace(_workspaceId: string, _limit: number) {
    // The fake doesn't know the agent → workspace mapping; the
    // test seeds a single workspace so we return all rows.
    return [...this.rows];
  }
  async listForUser(_workspaceId: string, userId: string, _limit: number) {
    // owner OR sharee
    return this.rows.filter(
      (r) =>
        r.triggeredByUserId === userId ||
        this.shareRows.some(
          (s) => s.sessionId === r.id && s.userId === userId,
        ),
    );
  }
  async listChildren() {
    return [];
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
  // (userId, workspaceId) pairs — admin scope is per-workspace, not
  // global. Without this you accidentally let a WS_B admin pass the
  // WS_A check, which is exactly the bug the cross-workspace test
  // exists to catch.
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
const ALICE_SESSION = SessionId("00000000-0000-7000-8000-000000000001");
const BOB_SESSION = SessionId("00000000-0000-7000-8000-000000000002");
const DAVE_SESSION = SessionId("00000000-0000-7000-8000-000000000003");

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
let shares: FakeShares;
let adminGuard: AdminGuard;
let actor: { userId: ReturnType<typeof UserId>; email: Email };
let app: Hono;

function build() {
  const routes = createWorkspaceSessionRoutes({
    agents: agents as never,
    sessions: sessions as never,
    events: { listBySession: async () => [] } as never,
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
  root.route("/api/workspaces/:slug/sessions", routes);
  return root;
}

beforeEach(() => {
  sessions = new FakeSessions();
  agents = new FakeAgents();
  shares = new FakeShares();
  adminGuard = new AdminGuard();

  agents.add(makeAgent(AGENT_A, WS_A));
  agents.add(makeAgent(AGENT_B, WS_B));
  sessions.add(makeSession(ALICE_SESSION, AGENT_A, ALICE));
  sessions.add(makeSession(BOB_SESSION, AGENT_A, BOB));
  sessions.add(makeSession(DAVE_SESSION, AGENT_B, DAVE));

  // Bob shared his session with Alice.
  shares.add(BOB_SESSION, ALICE);
  // FakeSessions.listForUser needs the same view.
  sessions.share(BOB_SESSION, ALICE);

  // Workspace admins — per-workspace, not global.
  adminGuard.setAdmin(CAROL, WS_A);
  adminGuard.setAdmin(DAVE, WS_B);
});

describe("workspace sessions list — visibility", () => {
  it("admin sees every session in the workspace", async () => {
    actor = { userId: CAROL, email: "c@x.com" as Email };
    app = build();
    const res = await app.request("/api/workspaces/ws-a/sessions");
    expect(res.status).toBe(200);
    const { sessions: ss } = (await res.json()) as {
      sessions: { id: string }[];
    };
    const ids = ss.map((s) => s.id);
    expect(ids).toContain(ALICE_SESSION);
    expect(ids).toContain(BOB_SESSION);
  });

  it("owner sees own + sessions explicitly shared with them", async () => {
    actor = { userId: ALICE, email: "a@x.com" as Email };
    app = build();
    const res = await app.request("/api/workspaces/ws-a/sessions");
    expect(res.status).toBe(200);
    const { sessions: ss } = (await res.json()) as {
      sessions: { id: string }[];
    };
    const ids = ss.map((s) => s.id);
    expect(ids).toContain(ALICE_SESSION); // owner
    expect(ids).toContain(BOB_SESSION); // sharee
  });

  it("non-owner non-admin non-sharee sees only their own", async () => {
    actor = { userId: BOB, email: "b@x.com" as Email };
    app = build();
    const res = await app.request("/api/workspaces/ws-a/sessions");
    expect(res.status).toBe(200);
    const { sessions: ss } = (await res.json()) as {
      sessions: { id: string }[];
    };
    const ids = ss.map((s) => s.id);
    expect(ids).toContain(BOB_SESSION);
    expect(ids).not.toContain(ALICE_SESSION);
  });
});

describe("workspace session detail — visibility", () => {
  it("owner can GET their own session", async () => {
    actor = { userId: ALICE, email: "a@x.com" as Email };
    app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${ALICE_SESSION}`,
    );
    expect(res.status).toBe(200);
  });

  it("sharee can GET a session shared with them", async () => {
    actor = { userId: ALICE, email: "a@x.com" as Email };
    app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${BOB_SESSION}`,
    );
    expect(res.status).toBe(200);
  });

  it("workspace admin can GET any session in the workspace", async () => {
    actor = { userId: CAROL, email: "c@x.com" as Email };
    app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${ALICE_SESSION}`,
    );
    expect(res.status).toBe(200);
  });

  it("non-owner non-admin non-sharee gets 404", async () => {
    actor = { userId: BOB, email: "b@x.com" as Email };
    app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${ALICE_SESSION}`,
    );
    expect(res.status).toBe(404);
  });

  it("cross-workspace: an admin of B gets 404 on a session in A", async () => {
    // Even though Dave is admin in WS_B, the URL says WS_A; the agent
    // for ALICE_SESSION is in WS_A so it must collapse to 404 — not
    // leak that the session exists.
    actor = { userId: DAVE, email: "d@x.com" as Email };
    app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${ALICE_SESSION}`,
    );
    expect(res.status).toBe(404);
  });

  it("cross-workspace: session id from B is invisible via A's URL", async () => {
    actor = { userId: CAROL, email: "c@x.com" as Email };
    app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${DAVE_SESSION}`,
    );
    expect(res.status).toBe(404);
  });
});
