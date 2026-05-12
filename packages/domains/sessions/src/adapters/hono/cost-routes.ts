import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
  systemClock,
  type Clock,
} from "@x1agent/kernel";
import type { AgentRepository } from "@x1agent/domain-agents";
import { AgentId } from "@x1agent/domain-agents";
import type { SessionRepository } from "../../ports/session-repository.js";
import { SessionId } from "../../domain/session.js";
import type {
  AgentCostWindow,
  TokenUsageRepository,
} from "../../ports/token-usage-repository.js";
import type { SessionShareRepository } from "../../ports/session-share-repository.js";
import type { AdminGuard } from "../../ports/admin-guard.js";

/**
 * Workspace-scoped cost routes — the read side of X1A-37.
 *
 * Mounted by the composition root at:
 *   /api/workspaces/:slug/sessions/:sessionId/cost
 *   /api/workspaces/:slug/sessions/:sessionId/cost-tree
 *   /api/workspaces/:slug/agents/:agentId/cost?window=24h|7d|30d|all
 *
 * Authorization mirrors session routes: workspace admin OR session
 * owner OR session sharee can read session-scoped cost. Agent-page
 * cost is workspace-admin-only (it's a rollup across every session,
 * including ones the caller may not own).
 *
 * Workspace-scoping is sacred per CLAUDE.md §7 — the repository
 * methods re-check workspace_id in their WHERE clauses, but we also
 * resolve workspace via slug + verify ownership here so a missing
 * adapter check never silently leaks.
 */
export interface CostRoutesConfig {
  sessions: SessionRepository;
  agents: AgentRepository;
  tokenUsage: TokenUsageRepository;
  shares?: SessionShareRepository;
  adminGuard: AdminGuard;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
  clock?: Clock;
}

const WINDOWS: readonly AgentCostWindow[] = ["24h", "7d", "30d", "all"];

function parseWindow(raw: string | undefined): AgentCostWindow {
  if (raw && (WINDOWS as readonly string[]).includes(raw)) {
    return raw as AgentCostWindow;
  }
  // Mockup-greenlit default: 7d. Locked.
  return "7d";
}

async function loadSession(
  cfg: CostRoutesConfig,
  workspaceId: WorkspaceId,
  sessionId: string,
) {
  const s = await cfg.sessions.findById(SessionId(sessionId));
  if (!s) return null;
  // Re-verify workspace scoping at the route layer in addition to the
  // adapter's WHERE clause. Belt + suspenders per CLAUDE.md §7.
  const agent = await cfg.agents.findById(s.agentId);
  if (!agent || agent.workspaceId !== workspaceId) return null;
  return s;
}

async function isSessionVisibleToActor(
  cfg: CostRoutesConfig,
  sessionId: string,
  ownerUserId: UserId | null,
  workspaceId: WorkspaceId,
  actor: { userId: UserId; email: Email },
): Promise<boolean> {
  // Admin always wins.
  try {
    await cfg.adminGuard.assertAdmin(actor.userId, workspaceId);
    return true;
  } catch {
    // not admin — fall through
  }
  if (ownerUserId && ownerUserId === actor.userId) return true;
  if (!cfg.shares) return false;
  const share = await cfg.shares.findForUser(
    SessionId(sessionId),
    actor.userId,
  );
  return share !== null;
}

export function createWorkspaceCostRoutes(cfg: CostRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  // GET /sessions/:sessionId/cost — single-session rollup. Powers
  // the live "This session" block on the session detail page.
  app.get("/sessions/:sessionId/cost", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    const sessionIdRaw = c.req.param("sessionId");
    if (!slug || !sessionIdRaw) return c.json({ error: "missing_param" }, 400);

    let wsId: WorkspaceId | null;
    try {
      wsId = await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return c.json({ error: "workspace_not_found" }, 404);
    }
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const session = await loadSession(cfg, wsId, sessionIdRaw);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    const visible = await isSessionVisibleToActor(
      cfg,
      sessionIdRaw,
      session.triggeredByUserId,
      wsId,
      actor,
    );
    if (!visible) return c.json({ error: "forbidden" }, 403);

    const rollup = await cfg.tokenUsage.rollupForSession({
      sessionId: sessionIdRaw,
      workspaceId: wsId,
    });
    return c.json(rollup);
  });

  // GET /sessions/:sessionId/cost-tree — parent + transitively-spawned
  // children. Same auth rules as /cost; the tree query is workspace-
  // scoped so it cannot escape into another tenant's spend.
  app.get("/sessions/:sessionId/cost-tree", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    const sessionIdRaw = c.req.param("sessionId");
    if (!slug || !sessionIdRaw) return c.json({ error: "missing_param" }, 400);

    let wsId: WorkspaceId | null;
    try {
      wsId = await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return c.json({ error: "workspace_not_found" }, 404);
    }
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const session = await loadSession(cfg, wsId, sessionIdRaw);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    const visible = await isSessionVisibleToActor(
      cfg,
      sessionIdRaw,
      session.triggeredByUserId,
      wsId,
      actor,
    );
    if (!visible) return c.json({ error: "forbidden" }, 403);

    const rollup = await cfg.tokenUsage.rollupForSessionTree({
      sessionId: sessionIdRaw,
      workspaceId: wsId,
    });
    return c.json(rollup);
  });

  // GET /agents/:agentId/cost?window=…  — rollup for every session the
  // agent ever ran in the window. Admin-only — surfaces sessions the
  // caller may not personally own.
  app.get("/agents/:agentId/cost", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    const agentIdRaw = c.req.param("agentId");
    if (!slug || !agentIdRaw) return c.json({ error: "missing_param" }, 400);

    let wsId: WorkspaceId | null;
    try {
      wsId = await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return c.json({ error: "workspace_not_found" }, 404);
    }
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    try {
      await cfg.adminGuard.assertAdmin(actor.userId, wsId);
    } catch {
      return c.json({ error: "forbidden" }, 403);
    }

    // Reject cross-workspace agent ids before hitting the rollup.
    const agent = await cfg.agents.findById(AgentId(agentIdRaw));
    if (!agent || agent.workspaceId !== wsId) {
      return c.json({ error: "agent_not_found" }, 404);
    }

    const window = parseWindow(c.req.query("window"));
    const clock = cfg.clock ?? systemClock;
    const rollup = await cfg.tokenUsage.rollupForAgent({
      agentId: agentIdRaw,
      workspaceId: wsId,
      window,
      now: clock.now(),
    });
    return c.json(rollup);
  });

  return app;
}
