import { describe, expect, it } from "bun:test";
import { WorkspaceSlug, type WorkspaceId, type UserId } from "@x1agent/kernel";
import { Hono } from "hono";
import { createWorkspaceCostRoutes } from "./cost-routes.js";
import type {
  AgentTokenUsageRollup,
  SessionTokenUsageRollup,
  SessionTreeRollup,
  TokenUsageRepository,
} from "../../ports/token-usage-repository.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { Session, SessionId } from "../../domain/session.js";
import type { AdminGuard } from "../../ports/admin-guard.js";
import type { AgentRepository } from "@x1agent/domain-agents";

/**
 * End-to-end exercise of /cost, /cost-tree, /agents/:id/cost — not
 * the SQL itself (that needs Postgres and a contract test), but the
 * route layer + auth gates. The repository is a stub so we focus on
 * "did we 403 the wrong tenant", "did we resolve the right session",
 * "did we forward the rollup verbatim".
 */

const W_A = "00000000-0000-7000-8000-aaaaaaaaaaaa" as unknown as WorkspaceId;
const W_B = "00000000-0000-7000-8000-bbbbbbbbbbbb" as unknown as WorkspaceId;
const SESSION_A = "00000000-0000-7000-8000-000000000001" as unknown as SessionId;
const AGENT_A = "00000000-0000-7000-8000-000000000010";
const AGENT_B = "00000000-0000-7000-8000-000000000020";
const ADMIN_USER_ID = "00000000-0000-7000-8000-000000000100" as unknown as UserId;
const OWNER_USER_ID = "00000000-0000-7000-8000-000000000101" as unknown as UserId;
const STRANGER_USER_ID =
  "00000000-0000-7000-8000-000000000102" as unknown as UserId;

function fakeRollup(): SessionTokenUsageRollup {
  return {
    sessionId: SESSION_A as unknown as string,
    totals: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsdEstimate: 0.42,
      cacheSavingsUsdEstimate: 0,
    },
    byModel: [],
  };
}

function fakeTree(): SessionTreeRollup {
  return {
    rootSessionId: SESSION_A as unknown as string,
    parent: fakeRollup(),
    children: [],
    totals: fakeRollup().totals,
  };
}

function fakeAgentRollup(): AgentTokenUsageRollup {
  return {
    agentId: AGENT_A,
    window: "7d",
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsdEstimate: 1.23,
    },
    byModel: [],
    byDay: [],
    topSessions: [],
  };
}

function makeSession(opts: {
  workspaceId: WorkspaceId;
  agentId: string;
  ownerUserId: UserId | null;
}): Session {
  return {
    id: SESSION_A,
    agentId: opts.agentId as never,
    triggeredBy: "user",
    triggeredByUserId: opts.ownerUserId,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: new Date("2026-05-12T00:00:00Z"),
    status: "running",
    completedAt: null,
    errorMessage: null,
    createdAt: new Date("2026-05-12T00:00:00Z"),
    summary: null,
    summaryUpdatedAt: null,
    summaryEventSeq: null,
  } as unknown as Session;
}

function makeApp(opts: {
  actorUserId: UserId | null;
  isAdmin: boolean;
  session: Session | null;
  agentWorkspaceId: WorkspaceId;
  agentId: string;
  workspaceForSlug: Record<string, WorkspaceId | null>;
}) {
  const tokenUsage: TokenUsageRepository = {
    record: async () => {},
    rollupForWorkspace: async () =>
      ({}) as never,
    rollupForSession: async () => fakeRollup(),
    rollupForSessionTree: async () => fakeTree(),
    rollupForAgent: async () => fakeAgentRollup(),
  };
  const sessions: SessionRepository = {
    create: async () => {
      throw new Error("not used");
    },
    findById: async (id) => (id === SESSION_A ? opts.session : null),
    listByAgent: async () => [],
    listByWorkspace: async () => [],
    listForUser: async () => [],
    lastSchedulerRunFor: async () => null,
    findLiveSessionForAgent: async () => null,
    listChildren: async () => [],
    updateStatus: async () => {
      throw new Error("not used");
    },
    updateSummary: async () => false,
    listNonTerminalOlderThan: async () => [],
    delete: async () => false,
  } as unknown as SessionRepository;
  const agents: AgentRepository = {
    findById: async (id) =>
      id === opts.agentId
        ? ({ id: opts.agentId, workspaceId: opts.agentWorkspaceId } as never)
        : null,
  } as unknown as AgentRepository;
  const adminGuard: AdminGuard = {
    assertAdmin: async () => {
      if (!opts.isAdmin) throw new Error("not_admin");
    },
    assertMember: async () => {},
  };
  const app = new Hono();
  const sub = createWorkspaceCostRoutes({
    sessions,
    agents,
    tokenUsage,
    adminGuard,
    resolveWorkspace: async (slug) =>
      opts.workspaceForSlug[String(slug)] ?? null,
    requireAuth: async (_c, next) => {
      await next();
    },
    getActor: () =>
      opts.actorUserId
        ? { userId: opts.actorUserId, email: "x@example.com" as never }
        : null,
  });
  app.route("/api/workspaces/:slug", sub);
  return app;
}

describe("cost routes — session rollup", () => {
  it("returns the rollup for the session owner", async () => {
    const session = makeSession({
      workspaceId: W_A,
      agentId: AGENT_A,
      ownerUserId: OWNER_USER_ID,
    });
    const app = makeApp({
      actorUserId: OWNER_USER_ID,
      isAdmin: false,
      session,
      agentWorkspaceId: W_A,
      agentId: AGENT_A,
      workspaceForSlug: { "ws-a": W_A },
    });
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/cost`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.costUsdEstimate).toBeCloseTo(0.42, 6);
  });

  it("forbids the stranger user", async () => {
    const session = makeSession({
      workspaceId: W_A,
      agentId: AGENT_A,
      ownerUserId: OWNER_USER_ID,
    });
    const app = makeApp({
      actorUserId: STRANGER_USER_ID,
      isAdmin: false,
      session,
      agentWorkspaceId: W_A,
      agentId: AGENT_A,
      workspaceForSlug: { "ws-a": W_A },
    });
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/cost`,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the session is in a different workspace (cross-tenant IDOR)", async () => {
    // Workspace A actor asks for a session that belongs to workspace B.
    // The agent lookup resolves to B's workspace; route MUST reject.
    const session = makeSession({
      workspaceId: W_B,
      agentId: AGENT_B,
      ownerUserId: OWNER_USER_ID,
    });
    const app = makeApp({
      actorUserId: OWNER_USER_ID,
      isAdmin: true,
      session,
      agentWorkspaceId: W_B,
      agentId: AGENT_B,
      workspaceForSlug: { "ws-a": W_A },
    });
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/cost`,
    );
    expect(res.status).toBe(404);
  });

  it("admin sees any session in their workspace", async () => {
    const session = makeSession({
      workspaceId: W_A,
      agentId: AGENT_A,
      ownerUserId: OWNER_USER_ID,
    });
    const app = makeApp({
      actorUserId: ADMIN_USER_ID,
      isAdmin: true,
      session,
      agentWorkspaceId: W_A,
      agentId: AGENT_A,
      workspaceForSlug: { "ws-a": W_A },
    });
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/cost`,
    );
    expect(res.status).toBe(200);
  });
});

describe("cost routes — agent rollup window default", () => {
  it("defaults to 7d when no window query param is set", async () => {
    let captured: string | null = null;
    const tokenUsage: TokenUsageRepository = {
      record: async () => {},
      rollupForWorkspace: async () => ({}) as never,
      rollupForSession: async () => fakeRollup(),
      rollupForSessionTree: async () => fakeTree(),
      rollupForAgent: async (i) => {
        captured = i.window;
        return fakeAgentRollup();
      },
    };
    const app = new Hono();
    app.route(
      "/api/workspaces/:slug",
      createWorkspaceCostRoutes({
        sessions: {
          findById: async () => null,
        } as unknown as SessionRepository,
        agents: {
          findById: async () =>
            ({ id: AGENT_A, workspaceId: W_A }) as never,
        } as unknown as AgentRepository,
        tokenUsage,
        adminGuard: { assertAdmin: async () => {}, assertMember: async () => {} },
        resolveWorkspace: async () => W_A,
        requireAuth: async (_c, next) => {
          await next();
        },
        getActor: () => ({
          userId: ADMIN_USER_ID,
          email: "x@example.com" as never,
        }),
      }),
    );
    const res = await app.request(
      `/api/workspaces/ws-a/agents/${AGENT_A}/cost`,
    );
    expect(res.status).toBe(200);
    expect(captured).toBe("7d");
  });

  it("rejects an agent id from another workspace (cross-tenant)", async () => {
    const app = new Hono();
    app.route(
      "/api/workspaces/:slug",
      createWorkspaceCostRoutes({
        sessions: {
          findById: async () => null,
        } as unknown as SessionRepository,
        agents: {
          findById: async () =>
            ({ id: AGENT_B, workspaceId: W_B }) as never,
        } as unknown as AgentRepository,
        tokenUsage: {
          record: async () => {},
          rollupForWorkspace: async () => ({}) as never,
          rollupForSession: async () => fakeRollup(),
          rollupForSessionTree: async () => fakeTree(),
          rollupForAgent: async () => fakeAgentRollup(),
        },
        adminGuard: { assertAdmin: async () => {}, assertMember: async () => {} },
        resolveWorkspace: async () => W_A,
        requireAuth: async (_c, next) => {
          await next();
        },
        getActor: () => ({
          userId: ADMIN_USER_ID,
          email: "x@example.com" as never,
        }),
      }),
    );
    const res = await app.request(
      `/api/workspaces/ws-a/agents/${AGENT_B}/cost`,
    );
    expect(res.status).toBe(404);
  });

  it("uses workspace slug suffix to feed window from query", async () => {
    let captured: string | null = null;
    const app = new Hono();
    app.route(
      "/api/workspaces/:slug",
      createWorkspaceCostRoutes({
        sessions: {
          findById: async () => null,
        } as unknown as SessionRepository,
        agents: {
          findById: async () =>
            ({ id: AGENT_A, workspaceId: W_A }) as never,
        } as unknown as AgentRepository,
        tokenUsage: {
          record: async () => {},
          rollupForWorkspace: async () => ({}) as never,
          rollupForSession: async () => fakeRollup(),
          rollupForSessionTree: async () => fakeTree(),
          rollupForAgent: async (i) => {
            captured = i.window;
            return fakeAgentRollup();
          },
        },
        adminGuard: { assertAdmin: async () => {}, assertMember: async () => {} },
        resolveWorkspace: async () => W_A,
        requireAuth: async (_c, next) => {
          await next();
        },
        getActor: () => ({
          userId: ADMIN_USER_ID,
          email: "x@example.com" as never,
        }),
      }),
    );
    const res = await app.request(
      `/api/workspaces/ws-a/agents/${AGENT_A}/cost?window=30d`,
    );
    expect(res.status).toBe(200);
    expect(captured).toBe("30d");
  });

  it("rejects unknown window values by falling back to 7d (defensive)", async () => {
    let captured: string | null = null;
    const app = new Hono();
    app.route(
      "/api/workspaces/:slug",
      createWorkspaceCostRoutes({
        sessions: {
          findById: async () => null,
        } as unknown as SessionRepository,
        agents: {
          findById: async () =>
            ({ id: AGENT_A, workspaceId: W_A }) as never,
        } as unknown as AgentRepository,
        tokenUsage: {
          record: async () => {},
          rollupForWorkspace: async () => ({}) as never,
          rollupForSession: async () => fakeRollup(),
          rollupForSessionTree: async () => fakeTree(),
          rollupForAgent: async (i) => {
            captured = i.window;
            return fakeAgentRollup();
          },
        },
        adminGuard: { assertAdmin: async () => {}, assertMember: async () => {} },
        resolveWorkspace: async () => W_A,
        requireAuth: async (_c, next) => {
          await next();
        },
        getActor: () => ({
          userId: ADMIN_USER_ID,
          email: "x@example.com" as never,
        }),
      }),
    );
    const res = await app.request(
      `/api/workspaces/ws-a/agents/${AGENT_A}/cost?window=420y`,
    );
    expect(res.status).toBe(200);
    expect(captured).toBe("7d");
  });
});
