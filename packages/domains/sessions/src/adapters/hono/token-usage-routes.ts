import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { AdminGuard } from "../../ports/admin-guard.js";
import type { TokenUsageRepository } from "../../ports/token-usage-repository.js";

export interface TokenUsageRoutesConfig {
  tokenUsage: TokenUsageRepository;
  adminGuard: AdminGuard;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

/**
 * Workspace-scoped token-usage rollup. Mounted at:
 *   /api/workspaces/:slug/token-usage
 *
 * Query params:
 *   ?since=YYYY-MM-DD  inclusive lower bound. Default: first day of
 *                      the current UTC month.
 *   ?until=YYYY-MM-DD  exclusive upper bound. Default: first day of
 *                      the next UTC month.
 *
 * Returns:
 *   {
 *     range: { since, until },
 *     totals:                 { input/output/cache tokens + cost_usd },
 *     byAgent:                [...],
 *     byModel:                [...],
 *     byDay:                  [...],
 *     byTriggerSource:        [{ triggered_by: "user"|"scheduler"|"agent", … }],
 *     byUser:                 [{ user_id, name, email, … }] (user-triggered only),
 *     byDayByTriggerSource:   [{ day, triggered_by, … }] (drives stacked chart)
 *   }
 *
 * Admin-only — token usage maps directly to spend.
 */
export function createWorkspaceTokenUsageRoutes(
  cfg: TokenUsageRoutesConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    if (!slug) return c.json({ error: "missing_slug" }, 400);

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

    const { since, until } = parseRange(
      c.req.query("since"),
      c.req.query("until"),
    );
    if (until <= since) {
      return c.json({ error: "until_must_be_after_since" }, 400);
    }

    const rollup = await cfg.tokenUsage.rollupForWorkspace({
      workspaceId: wsId,
      since,
      until,
    });

    return c.json({
      range: { since: since.toISOString(), until: until.toISOString() },
      ...rollup,
    });
  });

  return app;
}

function parseRange(
  sinceStr: string | undefined,
  untilStr: string | undefined,
): { since: Date; until: Date } {
  const now = new Date();
  // Defaults: current UTC month start → next UTC month start.
  const defaultSince = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const defaultUntil = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );

  // Accept YYYY-MM-DD; parse as UTC midnight to avoid local-tz drift.
  const parseDay = (s: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(y!, m! - 1, d!));
    return Number.isNaN(dt.getTime()) ? null : dt;
  };

  return {
    since: (sinceStr && parseDay(sinceStr)) || defaultSince,
    until: (untilStr && parseDay(untilStr)) || defaultUntil,
  };
}
