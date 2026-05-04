import { describe, expect, it } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import {
  createMcpOAuthRoutes,
  type OAuthRoutesConfig,
} from "./oauth-routes.js";
import type { OAuthFlowState } from "../../application/user-token-service.js";

/**
 * Hono integration tests for the OAuth browser-redirect routes.
 * Mocks the UserTokenService so we exercise the route layer alone:
 * cookie semantics, return_to allowlist, error rendering, callback
 * guards. None of these were covered before — the prod bug shipped
 * because the only test was a static type check.
 */

const APP_URL = "https://app.example.com";

const passingMiddleware: MiddlewareHandler = async (c, next) => {
  // Stand-in for requireAuth + requireWorkspaceMembership. Real ones
  // populate workspaceId/userId from the session.
  c.set("workspaceId", "ws-1");
  c.set("userId", "user-1");
  await next();
};

function makeStartService(overrides: Partial<{
  authorizeUrl: string;
  flowState: OAuthFlowState;
  throws?: Error;
}> = {}) {
  return {
    start: async (input: {
      workspaceId: string;
      catalogEntryName: string;
      userId: string;
      returnTo: string;
    }) => {
      if (overrides.throws) throw overrides.throws;
      return {
        authorizeUrl:
          overrides.authorizeUrl ?? "https://provider.example.com/authorize?x=y",
        flowState:
          overrides.flowState ??
          ({
            state: "state-abc",
            codeVerifier: "verifier-xyz",
            catalogEntryId: "cat-1",
            workspaceId: input.workspaceId,
            userId: input.userId,
            returnTo: input.returnTo,
          } as OAuthFlowState),
        redirectUri: "https://api.example.com/auth/mcp/callback/ws-1/mercury",
      };
    },
    complete: async () => {
      throw new Error("not used");
    },
    list: async () => [],
    delete: async () => true,
    resolveValidAccessToken: async () => null,
  };
}

function makeRoutes(
  service: ReturnType<typeof makeStartService>,
  cfg: Partial<OAuthRoutesConfig> = {},
) {
  const app = new Hono();
  app.route(
    "/auth/mcp",
    createMcpOAuthRoutes({
      service: service as never,
      requireAuth: passingMiddleware,
      requireWorkspaceMembership: passingMiddleware,
      appUrl: APP_URL,
      signFlowState: (s) => `signed:${JSON.stringify(s)}`,
      verifyFlowState: (t) => {
        if (!t.startsWith("signed:")) return null;
        return JSON.parse(t.slice("signed:".length)) as OAuthFlowState;
      },
      ...cfg,
    }),
  );
  return app;
}

describe("/auth/mcp/start/:slug/:name", () => {
  it("redirects to authorize URL and emits a Set-Cookie with flow JWT", async () => {
    const service = makeStartService();
    const app = makeRoutes(service);
    const res = await app.request("/auth/mcp/start/ws-1/mercury");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://provider.example.com/authorize?x=y",
    );
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("x1_mcp_oauth_mercury=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
  });

  it("rejects catalog names that aren't cookie-safe", async () => {
    const service = makeStartService();
    const app = makeRoutes(service);
    // Names containing `;` would inject cookie attrs; `..` violates
    // the catalog-name regex. Either way the route should refuse
    // before allocating cookie state.
    const res = await app.request("/auth/mcp/start/ws-1/bad..name");
    expect(res.status).toBe(400);
  });

  it("falls back to default return_to when query value is cross-origin (open redirect guard)", async () => {
    const captured: { returnTo?: string } = {};
    const service = {
      ...makeStartService(),
      start: async (input: { returnTo: string }) => {
        captured.returnTo = input.returnTo;
        return {
          authorizeUrl: "https://provider.example.com/authorize",
          flowState: {
            state: "s",
            codeVerifier: "v",
            catalogEntryId: "cat-1",
            workspaceId: "ws-1",
            userId: "user-1",
            returnTo: input.returnTo,
          } as OAuthFlowState,
          redirectUri: "x",
        };
      },
    };
    const app = makeRoutes(service as never);
    await app.request(
      "/auth/mcp/start/ws-1/mercury?return_to=" +
        encodeURIComponent("https://evil.example/landing"),
    );
    // Was attacker URL → must be discarded, default substituted.
    expect(captured.returnTo).toBe(`${APP_URL}/workspaces/ws-1`);
  });

  it("accepts same-origin return_to", async () => {
    const captured: { returnTo?: string } = {};
    const service = {
      ...makeStartService(),
      start: async (input: { returnTo: string }) => {
        captured.returnTo = input.returnTo;
        return {
          authorizeUrl: "https://provider.example.com/authorize",
          flowState: {
            state: "s",
            codeVerifier: "v",
            catalogEntryId: "cat-1",
            workspaceId: "ws-1",
            userId: "user-1",
            returnTo: input.returnTo,
          } as OAuthFlowState,
          redirectUri: "x",
        };
      },
    };
    const app = makeRoutes(service as never);
    const safe = `${APP_URL}/workspaces/ws-1/agents/general/edit?tab=mcp`;
    await app.request(
      "/auth/mcp/start/ws-1/mercury?return_to=" + encodeURIComponent(safe),
    );
    expect(captured.returnTo).toBe(safe);
  });
});

describe("/auth/mcp/callback/:slug/:name", () => {
  it("rejects when workspace from the URL doesn't match the flow's workspace", async () => {
    const service = {
      ...makeStartService(),
      complete: async () => {
        throw new Error("complete should not run on workspace mismatch");
      },
    };
    const app = makeRoutes(service as never);
    // Cookie carries a flow signed for ws-2, but URL is ws-1.
    const cookie = `x1_mcp_oauth_mercury=signed:${JSON.stringify({
      state: "s",
      codeVerifier: "v",
      catalogEntryId: "cat-1",
      workspaceId: "ws-2",
      userId: "user-1",
      returnTo: `${APP_URL}/x`,
    })}`;
    const res = await app.request(
      "/auth/mcp/callback/ws-1/mercury?code=c&state=s",
      {
        headers: { Cookie: cookie },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("workspace");
  });

  it("wipes the flow cookie when the provider returns ?error=", async () => {
    const service = makeStartService();
    const app = makeRoutes(service);
    const cookie = `x1_mcp_oauth_mercury=signed:${JSON.stringify({
      state: "s",
      codeVerifier: "v",
      catalogEntryId: "cat-1",
      workspaceId: "ws-1",
      userId: "user-1",
      returnTo: `${APP_URL}/x`,
    })}`;
    const res = await app.request(
      "/auth/mcp/callback/ws-1/mercury?error=access_denied",
      { headers: { Cookie: cookie } },
    );
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("x1_mcp_oauth_mercury=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("does NOT echo upstream provider error bodies in the rendered HTML", async () => {
    // Even on a token-exchange failure, the user-facing message must
    // be generic. Test this with a complete() that throws an error
    // including a `client_secret` echo, which used to land verbatim
    // in the HTML.
    const service = {
      ...makeStartService(),
      complete: async () => {
        throw Object.assign(new Error("HTTP 400: { client_secret: 'sk-XXX' }"), {
          field: "token",
        });
      },
    };
    const app = makeRoutes(service as never);
    const cookie = `x1_mcp_oauth_mercury=signed:${JSON.stringify({
      state: "s",
      codeVerifier: "v",
      catalogEntryId: "cat-1",
      workspaceId: "ws-1",
      userId: "user-1",
      returnTo: `${APP_URL}/x`,
    })}`;
    const res = await app.request(
      "/auth/mcp/callback/ws-1/mercury?code=c&state=s",
      { headers: { Cookie: cookie } },
    );
    const body = await res.text();
    expect(body).not.toContain("sk-XXX");
    expect(body).not.toContain("client_secret");
  });
});
