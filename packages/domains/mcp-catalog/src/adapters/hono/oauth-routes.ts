import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
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

/**
 * Catalog names are validated by CatalogName() to `[a-z][a-z0-9_-]{0,63}`,
 * but the Hono route reads the raw URL param. Re-check before we use it
 * as part of a cookie key — anything outside this set risks malformed
 * Set-Cookie headers (browser drops the cookie → flow always fails) or
 * collision with a different MCP's flow cookie.
 */
const COOKIE_SAFE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function flowCookieName(catalogName: string): string | null {
  if (!COOKIE_SAFE_NAME_RE.test(catalogName)) return null;
  return `${FLOW_COOKIE_PREFIX}${catalogName}`;
}

/**
 * Resolve the `return_to` query param against the app origin and reject
 * any URL that doesn't end up same-origin with appUrl. Phishing primitive
 * if we let an attacker pick the post-callback redirect target — they
 * could send a real x1agent OAuth link that bounces the user to evil.tld
 * after a successful provider consent.
 *
 * Returns null when `raw` is unsafe; the caller falls back to the default.
 */
function safeReturnTo(raw: string | undefined, appUrl: string): string | null {
  if (!raw) return null;
  let app: URL;
  try {
    app = new URL(appUrl);
  } catch {
    return null;
  }
  let candidate: URL;
  try {
    // Resolve relatively against appUrl so a bare path ("/foo") becomes
    // appUrl/foo. Anything absolute keeps its own origin.
    candidate = new URL(raw, appUrl);
  } catch {
    return null;
  }
  if (candidate.origin !== app.origin) return null;
  return candidate.toString();
}

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
      const cookieName = flowCookieName(name);
      if (!cookieName) {
        return c.json({ error: "invalid catalog name" }, 400);
      }
      const defaultReturnTo = `${cfg.appUrl}/workspaces/${slug}`;
      const returnTo =
        safeReturnTo(c.req.query("return_to"), cfg.appUrl) ?? defaultReturnTo;
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
        setCookie(c, cookieName, flowToken, {
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 300,
          secure: true,
        });
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
      const cookieName = flowCookieName(name);
      if (!cookieName) {
        return c.html(
          renderErrorPage("Invalid catalog name", slug, cfg.appUrl),
        );
      }
      // Wipe the flow cookie regardless of which exit path we take below.
      // Even an invalid_grant from the provider should not leave a
      // replayable flow JWT in the user's browser.
      const wipeFlowCookie = () =>
        setCookie(c, cookieName, "", {
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 0,
          secure: true,
        });

      const code = c.req.query("code");
      const state = c.req.query("state");
      const error = c.req.query("error");
      if (error) {
        wipeFlowCookie();
        return c.html(
          renderErrorPage(`Provider returned: ${error}`, slug, cfg.appUrl),
        );
      }
      if (!code || !state) {
        wipeFlowCookie();
        return c.html(
          renderErrorPage("Provider redirect missing code or state", slug, cfg.appUrl),
        );
      }
      const flowToken = getCookie(c, cookieName);
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
        wipeFlowCookie();
        return c.html(
          renderErrorPage("OAuth flow state failed to verify", slug, cfg.appUrl),
        );
      }
      // Bind the callback to the same workspace the start flow was in.
      // The catalog-id check downstream catches most cross-workspace
      // confusion, but checking here is cheaper and clearer.
      if (flowState.workspaceId !== workspaceId) {
        wipeFlowCookie();
        return c.html(
          renderErrorPage(
            "OAuth callback workspace does not match the workspace the flow started in",
            slug,
            cfg.appUrl,
          ),
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
        wipeFlowCookie();
        // Defense-in-depth: re-validate the persisted return_to. It was
        // checked at /start, but we don't trust the signed state to carry
        // forward an old policy. Fall back to the workspace home if the
        // stored value is no longer same-origin.
        const safeReturn =
          safeReturnTo(flowState.returnTo, cfg.appUrl) ??
          `${cfg.appUrl}/workspaces/${slug}`;
        return c.redirect(safeReturn, 302);
      } catch (err) {
        // Don't echo upstream provider response bodies to the browser —
        // 4xx debug payloads sometimes contain submitted secrets, and
        // stack-shaped errors leak internal detail. Log server-side,
        // show a generic message client-side.
        wipeFlowCookie();
        const e = err as { field?: string; message?: string };
        console.warn(
          "[mcp-oauth] token exchange failed",
          {
            slug,
            name,
            userId,
            field: e.field ?? null,
            message: e.message ?? "unknown",
          },
        );
        return c.html(
          renderErrorPage(
            "Token exchange failed. Try connecting again, or contact your workspace admin if it persists.",
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
  // we control. Escape for both element-content AND attribute-value
  // contexts because slug/appUrl are interpolated into an href below.
  const safe = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  return `<!doctype html>
<html><head><title>OAuth flow failed</title></head>
<body style="font-family: system-ui; padding: 2rem; max-width: 32rem;">
  <h1>OAuth flow failed</h1>
  <p>${safe(message)}</p>
  <p><a href="${safe(appUrl)}/workspaces/${safe(slug)}">Return to workspace</a></p>
</body></html>`;
}
