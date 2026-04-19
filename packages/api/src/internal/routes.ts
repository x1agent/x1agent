import { Hono, type MiddlewareHandler } from "hono";
import type { GitHubAppClient, InstallationId } from "@x1agent/domain-github";
import type {
  SessionEventRepository,
  SessionId,
} from "@x1agent/domain-sessions";
import { appendSessionEvent } from "@x1agent/domain-sessions";

/**
 * Endpoints only the sidecar calls (same-cluster). Gated on a shared
 * secret header. The sidecar image receives the secret at deploy time
 * via the pod env; the api reads it from API_INTERNAL_TOKEN at boot.
 * Everything under /api/internal/* lives here.
 */
export interface InternalRoutesConfig {
  events: SessionEventRepository;
  githubClient: GitHubAppClient | null;
  internalToken: string;
}

function requireInternalToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      return c.json({ error: "internal_disabled" }, 503);
    }
    const header = c.req.header("x-internal-token");
    if (header !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

export function createInternalRoutes(cfg: InternalRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", requireInternalToken(cfg.internalToken));

  // Append a wire event from NATS / sidecar into durable storage.
  app.post("/sessions/:sessionId/events", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      seq?: number;
      type?: string;
      payload?: unknown;
      timestamp?: string;
    };
    if (
      typeof body.seq !== "number" ||
      typeof body.type !== "string"
    ) {
      return c.json({ error: "missing_fields" }, 400);
    }
    const row = await appendSessionEvent(
      { events: cfg.events },
      {
        sessionId: c.req.param("sessionId")! as SessionId,
        seq: body.seq,
        type: body.type,
        payload: body.payload ?? {},
        timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
      },
    );
    return c.json({ ok: true, duplicate: row === null });
  });

  // Mint a short-lived GitHub App installation token for the sidecar.
  // Returns it in git's credential-helper shape: (username, token).
  app.get("/git-credential", async (c) => {
    const idRaw = c.req.query("installation_id");
    if (!idRaw) return c.json({ error: "missing_installation_id" }, 400);
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "bad_installation_id" }, 400);
    }
    if (!cfg.githubClient) {
      return c.json({ error: "github_not_configured" }, 503);
    }
    try {
      const minted = await cfg.githubClient.mintInstallationToken(
        id as InstallationId,
      );
      return c.json({
        username: "x-access-token",
        token: minted.token,
        expires_at: minted.expiresAt.toISOString(),
      });
    } catch (err) {
      return c.json(
        {
          error: "mint_failed",
          message: (err as Error).message,
        },
        502,
      );
    }
  });

  return app;
}
