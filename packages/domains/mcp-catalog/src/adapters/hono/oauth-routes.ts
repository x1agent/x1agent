import { Hono, type MiddlewareHandler } from "hono";
import type { UserMcpToken } from "../../domain/user-token.js";
import type {
  OAuthFlowState,
  UserTokenService,
} from "../../application/user-token-service.js";

declare module "hono" {
  interface ContextVariableMap {
    workspaceId: string;
    userId: string | null;
  }
}

export interface OAuthRoutesConfig {
  service: UserTokenService;
  /** Authenticated middleware — populates ctx.session. */
  requireAuth: MiddlewareHandler;
  /** Resolves :slug to workspaceId + verifies the caller is a member.
   * Same shape as the catalog routes' inline gate, factored out so
   * both routes can reuse it. */
  requireWorkspaceMembership: MiddlewareHandler;
  /** Where to send the user after the callback completes. Used as
   * the default if the start request didn't pass `?return_to=`. */
  appUrl: string;
  /** Sign / verify the per-flow state cookie. The auth domain owns
   * JWT signing; we accept opaque sign/verify functions to stay
   * decoupled. */
  signFlowState: (state: OAuthFlowState) => string;
  verifyFlowState: (token: string) => OAuthFlowState | null;
}

const FLOW_COOKIE_PREFIX = "x1_mcp_oauth_";

function tokenToJson(t: UserMcpToken) {
  return {
    id: t.id,
    catalog_entry_id: t.catalogEntryId,
    access_token_expires_at: t.accessTokenExpiresAt?.toISOString() ?? null,
    scope: t.scope,
    has_refresh_token: t.hasRefreshToken,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  };
}

/**
 * Browser-redirect routes for the OAuth flow. Mounted at /auth/mcp:
 *   /auth/mcp/start/:slug/:name     — initiate
 *   /auth/mcp/callback/:slug/:name  — provider redirects here
 *
 * The redirect routes set / read a short-lived cookie carrying the
 * signed flow state (PKCE verifier + state + locked user_id). Cookie
 * name includes the catalog entry name so concurrent flows for two
 * different MCPs don't clobber each other.
 */
export function createMcpOAuthRoutes(cfg: OAuthRoutesConfig): Hono {
  const app = new Hono();

  // ── /auth/mcp/:slug/:name/start ──────────────────────────────────
  // Starting the flow needs the user to be authenticated (we lock
  // userId into the flow state so the callback can't bind tokens to
  // a different user). It also needs them to be a workspace member.
  app.get(
    "/start/:slug/:name",
    cfg.requireAuth,
    cfg.requireWorkspaceMembership,
    async (c) => {
      const slug = c.req.param("slug") ?? "";
      const name = c.req.param("name") ?? "";
      const workspaceId = c.get("workspaceId") as string;
      const userId = c.get("userId") as string | null;
      if (!userId) return c.json({ error: "unauthenticated" }, 401);
      const returnTo =
        c.req.query("return_to") ??
        `${cfg.appUrl}/workspaces/${slug}`;
      try {
        const start = await cfg.service.start({
          workspaceId,
          catalogEntryName: name,
          userId,
          returnTo,
        });
        const flowToken = cfg.signFlowState(start.flowState);
        // Cookie is short-lived (5 min) — flow should complete inside
        // that window. SameSite=Lax so the provider redirect carries
        // the cookie back; HttpOnly so the LLM can't read it.
        const cookieName = `${FLOW_COOKIE_PREFIX}${name}`;
        c.header(
          "Set-Cookie",
          [
            `${cookieName}=${flowToken}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=300",
            "Secure",
          ].join("; "),
        );
        return c.redirect(start.authorizeUrl, 302);
      } catch (err) {
        const e = err as { field?: string; message?: string };
        return c.json(
          { error: e.message ?? "start failed", field: e.field ?? null },
          400,
        );
      }
    },
  );

  // ── /auth/mcp/:slug/:name/callback ───────────────────────────────
  // Provider redirects here with ?code=&state=. We re-authenticate
  // the user (the cookie ride-along carries the session), validate
  // the flow cookie, and exchange.
  app.get(
    "/callback/:slug/:name",
    cfg.requireAuth,
    cfg.requireWorkspaceMembership,
    async (c) => {
      const slug = c.req.param("slug") ?? "";
      const name = c.req.param("name") ?? "";
      const workspaceId = c.get("workspaceId") as string;
      const userId = c.get("userId") as string | null;
      if (!userId) return c.json({ error: "unauthenticated" }, 401);
      const code = c.req.query("code");
      const state = c.req.query("state");
      const error = c.req.query("error");
      if (error) {
        return c.html(
          renderErrorPage(`Provider returned: ${error}`, slug, cfg.appUrl),
        );
      }
      if (!code || !state) {
        return c.html(
          renderErrorPage("Provider redirect missing code or state", slug, cfg.appUrl),
        );
      }
      const cookieName = `${FLOW_COOKIE_PREFIX}${name}`;
      const cookieHeader = c.req.header("Cookie") ?? "";
      const match = cookieHeader.match(
        new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`),
      );
      const flowToken = match?.[1];
      if (!flowToken) {
        return c.html(
          renderErrorPage(
            "OAuth flow state cookie missing or expired",
            slug,
            cfg.appUrl,
          ),
        );
      }
      const flowState = cfg.verifyFlowState(flowToken);
      if (!flowState) {
        return c.html(
          renderErrorPage("OAuth flow state failed to verify", slug, cfg.appUrl),
        );
      }
      try {
        await cfg.service.complete({
          workspaceId,
          catalogEntryName: name,
          userId,
          code,
          state,
          flowState,
        });
        // Wipe the flow cookie so it can't be replayed.
        c.header(
          "Set-Cookie",
          [
            `${cookieName}=`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=0",
            "Secure",
          ].join("; "),
        );
        return c.redirect(flowState.returnTo, 302);
      } catch (err) {
        const e = err as { field?: string; message?: string };
        return c.html(
          renderErrorPage(
            `Token exchange failed: ${e.message ?? "unknown"}`,
            slug,
            cfg.appUrl,
          ),
        );
      }
    },
  );

  return app;
}

/**
 * JSON status endpoints for the agent edit UI. Mounted under
 * /api/users/me/mcp-tokens — separate router so it can be wired
 * with normal API auth, not browser-redirect semantics.
 */
export function createMcpUserTokenRoutes(
  cfg: Pick<OAuthRoutesConfig, "service" | "requireAuth">,
): Hono {
  const app = new Hono();

  app.get("/me/mcp-tokens", cfg.requireAuth, async (c) => {
    const session = c.get("session") as
      | { userId: string | null }
      | undefined;
    if (!session?.userId) return c.json({ error: "unauthenticated" }, 401);
    const tokens = await cfg.service.list(session.userId);
    return c.json({ tokens: tokens.map(tokenToJson) });
  });

  app.delete(
    "/me/mcp-tokens/:catalogEntryId",
    cfg.requireAuth,
    async (c) => {
      const session = c.get("session") as
        | { userId: string | null }
        | undefined;
      if (!session?.userId) return c.json({ error: "unauthenticated" }, 401);
      const removed = await cfg.service.delete(
        session.userId,
        c.req.param("catalogEntryId") ?? "",
      );
      if (!removed) return c.json({ error: "not found" }, 404);
      return c.body(null, 204);
    },
  );

  return app;
}

function renderErrorPage(
  message: string,
  slug: string,
  appUrl: string,
): string {
  // Plain HTML — no template engine, no XSS surface beyond the message
  // we control. Escape the slug + message defensively.
  const safe = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html><head><title>OAuth flow failed</title></head>
<body style="font-family: system-ui; padding: 2rem; max-width: 32rem;">
  <h1>OAuth flow failed</h1>
  <p>${safe(message)}</p>
  <p><a href="${safe(appUrl)}/workspaces/${safe(slug)}">Return to workspace</a></p>
</body></html>`;
}
