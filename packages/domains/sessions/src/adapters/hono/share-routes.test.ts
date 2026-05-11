import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
  type Email,
} from "@x1agent/kernel";
import { AgentId, type Agent } from "@x1agent/domain-agents";
import type { Session } from "../../domain/session.js";
import { SessionId } from "../../domain/session.js";
import {
  SessionShareId,
  type SessionShare,
} from "../../domain/share.js";
import { createSessionShareRoutes } from "./share-routes.js";

// ─── Fakes ──────────────────────────────────────────────────────────
//
// Lightweight in-memory stand-ins for the four ports the routes touch:
// SessionRepository (only findById), AgentRepository (only findById),
// SessionShareRepository (full surface), and the workspace-resolver +
// admin-check callbacks. Mirrors the pattern in
// manage-session-shares.test.ts but at the HTTP-route layer so the
// regression covers the wiring bug fixed in X1A-44.

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

class FakeShares {
  rows: SessionShare[] = [];
  async upsert(input: {
    sessionId: string;
    userId: string;
    role: "viewer" | "collaborator";
    sharedBy: string;
  }) {
    const existing = this.rows.find(
      (r) => r.sessionId === input.sessionId && r.userId === input.userId,
    );
    if (existing) {
      existing.role = input.role;
      existing.sharedBy = input.sharedBy as never;
      return existing;
    }
    const row: SessionShare = {
      id: SessionShareId(`share-${this.rows.length + 1}`),
      sessionId: input.sessionId as never,
      userId: input.userId as never,
      role: input.role,
      sharedBy: input.sharedBy as never,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }
  async removeForUser(sessionId: string, userId: string) {
    this.rows = this.rows.filter(
      (r) => !(r.sessionId === sessionId && r.userId === userId),
    );
  }
  async findForUser(sessionId: string, userId: string) {
    return (
      this.rows.find(
        (r) => r.sessionId === sessionId && r.userId === userId,
      ) ?? null
    );
  }
  async listForSession(sessionId: string) {
    return this.rows.filter((r) => r.sessionId === sessionId);
  }
  async listForUser() {
    return [];
  }
  async remove() {}
}

const WS_A = WorkspaceId("00000000-0000-7000-8000-0000000000a1");
const WS_B = WorkspaceId("00000000-0000-7000-8000-0000000000b1");
const SLUG_A = WorkspaceSlug("ws-a");
const SLUG_B = WorkspaceSlug("ws-b");

const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const BOB = UserId("00000000-0000-7000-8000-00000000b0b0");
const CAROL = UserId("00000000-0000-7000-8000-00000000ca40");

const SESSION_A = SessionId("00000000-0000-7000-8000-000000000001");
const AGENT_A = AgentId("00000000-0000-7000-8000-0000000000a0");

function makeAgent(workspaceId: WorkspaceId, id = AGENT_A): Agent {
  // Cast through `unknown` because the test uses string-branded value
  // objects (slug/runtimeType) without minting them through their
  // factories — the route under test only cares about
  // `agent.workspaceId === wsId`, so the rest is filler.
  return {
    id,
    workspaceId,
    slug: "test-agent" as unknown,
    name: "Test Agent",
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

function makeSession(ownerId: ReturnType<typeof UserId>, id = SESSION_A): Session {
  return {
    id,
    agentId: AGENT_A,
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
let actor: { userId: ReturnType<typeof UserId>; email: Email };
let app: Hono;

function build({
  workspaceAdmin = false,
  emailToUser,
}: {
  workspaceAdmin?: boolean;
  emailToUser?: Record<string, ReturnType<typeof UserId>>;
} = {}) {
  const routes = createSessionShareRoutes({
    sessions: sessions as never,
    shares: shares as never,
    agents: agents as never,
    findUserIdByEmail: async (email) => emailToUser?.[email] ?? null,
    isWorkspaceAdmin: async () => workspaceAdmin,
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
    "/api/workspaces/:slug/sessions/:sessionId/user-shares",
    routes,
  );
  return root;
}

beforeEach(() => {
  sessions = new FakeSessions();
  agents = new FakeAgents();
  shares = new FakeShares();
  actor = { userId: ALICE, email: "alice@x1agent.com" as Email };
});

describe("share-routes — workspace resolution (X1A-44 regression)", () => {
  it("POST grants access when the session's agent is in the URL workspace", async () => {
    agents.add(makeAgent(WS_A));
    sessions.add(makeSession(ALICE));
    app = build({ emailToUser: { "bob@x1agent.com": BOB } });

    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/user-shares`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@x1agent.com", role: "viewer" }),
      },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { share: { user_id: string } };
    expect(body.share.user_id).toBe(BOB);
    expect(shares.rows.length).toBe(1);
  });

  it("POST returns 404 (not 200) when the session is in a DIFFERENT workspace", async () => {
    // Cross-tenant: session's agent lives in WS_A, the URL says WS_B.
    // The route must not leak the session into WS_B even though the
    // session row exists.
    agents.add(makeAgent(WS_A));
    sessions.add(makeSession(ALICE));
    app = build({
      workspaceAdmin: true, // even an admin in WS_B can't reach into WS_A
      emailToUser: { "bob@x1agent.com": BOB },
    });

    const res = await app.request(
      `/api/workspaces/ws-b/sessions/${SESSION_A}/user-shares`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@x1agent.com", role: "viewer" }),
      },
    );

    expect(res.status).toBe(404);
    expect(shares.rows.length).toBe(0);
  });

  it("GET lists current grants for a session in this workspace", async () => {
    agents.add(makeAgent(WS_A));
    sessions.add(makeSession(ALICE));
    await shares.upsert({
      sessionId: SESSION_A,
      userId: BOB,
      role: "viewer",
      sharedBy: ALICE,
    });
    app = build();

    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/user-shares`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: { user_id: string }[] };
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0]!.user_id).toBe(BOB);
  });

  it("DELETE revokes a grant when called by the owner", async () => {
    agents.add(makeAgent(WS_A));
    sessions.add(makeSession(ALICE));
    await shares.upsert({
      sessionId: SESSION_A,
      userId: BOB,
      role: "viewer",
      sharedBy: ALICE,
    });
    app = build();

    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/user-shares/${BOB}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(204);
    expect(shares.rows).toHaveLength(0);
  });

  it("POST 404s with session_not_found when the session id doesn't exist", async () => {
    agents.add(makeAgent(WS_A));
    app = build({ emailToUser: { "bob@x1agent.com": BOB } });

    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/user-shares`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@x1agent.com", role: "viewer" }),
      },
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "session_not_found",
    );
  });

  it("POST 403s when actor is neither owner nor workspace admin", async () => {
    agents.add(makeAgent(WS_A));
    sessions.add(makeSession(ALICE));
    actor = { userId: CAROL, email: "carol@x1agent.com" as Email };
    app = build({ emailToUser: { "bob@x1agent.com": BOB } });

    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/user-shares`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@x1agent.com", role: "viewer" }),
      },
    );

    expect(res.status).toBe(403);
  });
});
