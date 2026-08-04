import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createAdminMcpRoutes } from "./routes.js";
import type {
  AdminMcpOAuthStore,
  OAuthAuthorizationRequest,
  OAuthClient,
  OAuthPrincipal,
  OAuthTokenSet,
} from "./oauth-store.js";

const resourceUrl = "https://x1agent.example.test/mcp";
const authorizationServerUrl = "https://api.x1agent.example.test";
const verifier = "codex-test-verifier-that-is-long-enough-for-rfc-7636";
const challenge = createHash("sha256").update(verifier).digest("base64url");

class FakeOAuth implements AdminMcpOAuthStore {
  clients = new Map<string, OAuthClient>();
  authorizationRequests = new Map<string, OAuthAuthorizationRequest>();
  code: Parameters<AdminMcpOAuthStore["authorize"]>[0] | null = null;

  async registerClient(input: {
    clientName: string | null;
    redirectUris: string[];
  }) {
    const client = {
      clientId: `x1mcp_${this.clients.size + 1}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
    };
    this.clients.set(client.clientId, client);
    return client;
  }
  async findClient(clientId: string) {
    return this.clients.get(clientId) ?? null;
  }
  async createAuthorizationRequest(input: OAuthAuthorizationRequest) {
    const token = `consent-${this.authorizationRequests.size + 1}`;
    this.authorizationRequests.set(token, input);
    return token;
  }
  async consumeAuthorizationRequest(input: { token: string; userId: string }) {
    const request = this.authorizationRequests.get(input.token);
    if (!request || request.userId !== input.userId) return null;
    this.authorizationRequests.delete(input.token);
    return request;
  }
  async authorize(input: Parameters<AdminMcpOAuthStore["authorize"]>[0]) {
    this.code = input;
    return "one-time-code";
  }
  async exchangeAuthorizationCode(
    input: Parameters<AdminMcpOAuthStore["exchangeAuthorizationCode"]>[0],
  ): Promise<OAuthTokenSet | null> {
    if (
      !this.code ||
      input.code !== "one-time-code" ||
      input.clientId !== this.code.clientId ||
      input.redirectUri !== this.code.redirectUri ||
      input.resource !== this.code.resource ||
      input.codeVerifier !== verifier
    )
      return null;
    this.code = null;
    return {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "x1.workspaces.read",
    };
  }
  async exchangeRefreshToken(): Promise<OAuthTokenSet | null> {
    return null;
  }
  async verifyAccessToken(
    token: string,
    resource: string,
  ): Promise<OAuthPrincipal | null> {
    return token === "access-token" && resource === resourceUrl
      ? {
          userId: "user-1",
          clientId: "x1mcp_1",
          scopes: ["x1.workspaces.read"],
          expiresAt: 2_000_000_000,
        }
      : null;
  }
  async revoke(): Promise<void> {}
}

function fixture(signedIn = false) {
  const oauth = new FakeOAuth();
  const server = createAdminMcpRoutes({
    resourceUrl,
    authorizationServerUrl,
    enabled: true,
    oauth,
    tokenizer: {
      sign: () => "session-token",
      verify: (token) =>
        token === "session-token"
          ? {
              userId: "user-1" as never,
              email: "christian@x1agent.com" as never,
              name: "Christian",
              memberships: [],
              isPlatformAdmin: false,
            }
          : null,
    },
    workspaces: {
      listForUser: async () => [
        {
          id: "workspace-1",
          slug: "default",
          name: "Default",
          role: "owner",
          createdAt: "2026-08-03T00:00:00.000Z",
        },
      ],
      getForUser: async (_userId, slug) =>
        slug === "default"
          ? {
              id: "workspace-1",
              slug: "default",
              name: "Default",
              role: "owner",
              createdAt: "2026-08-03T00:00:00.000Z",
            }
          : null,
    },
  });
  const cookie: Record<string, string> = signedIn
    ? { Cookie: "x1_session=session-token" }
    : {};
  return { server, oauth, cookie };
}

async function register(server: ReturnType<typeof createAdminMcpRoutes>) {
  const response = await server.request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Codex",
      redirect_uris: ["http://127.0.0.1:49200/callback"],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

function authParams(clientId: string) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:49200/callback",
    resource: resourceUrl,
    scope: "x1.workspaces.read",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "codex-state",
  });
}

function consentToken(html: string): string {
  const value = html.match(/name="consent_token" value="([^"]+)"/)?.[1];
  if (!value) throw new Error("consent token not found");
  return value;
}

describe("public administrative MCP OAuth and transport", () => {
  test("challenges an unauthenticated MCP request with RFC 9728 metadata", async () => {
    const { server } = fixture();
    const res = await server.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `${authorizationServerUrl}/.well-known/oauth-protected-resource/mcp`,
    );
  });

  test("publishes protected-resource and authorization-server metadata", async () => {
    const { server } = fixture();
    const resource = await server.request(
      "/.well-known/oauth-protected-resource/mcp",
    );
    const auth = await server.request(
      "/.well-known/oauth-authorization-server",
    );
    expect(await resource.json()).toMatchObject({
      resource: resourceUrl,
      authorization_servers: [authorizationServerUrl],
    });
    expect(await auth.json()).toMatchObject({
      issuer: authorizationServerUrl,
      authorization_endpoint: `${authorizationServerUrl}/oauth/authorize`,
      token_endpoint: `${authorizationServerUrl}/oauth/token`,
      registration_endpoint: `${authorizationServerUrl}/oauth/register`,
    });
  });

  test("preserves the OAuth request through sign-in and renders branded consent", async () => {
    const { server } = fixture();
    const client = await register(server);
    const auth = await server.request(
      `/oauth/authorize?${authParams(client.client_id)}`,
    );
    const html = await auth.text();
    expect(auth.status).toBe(200);
    expect(html).toContain("Sign in to X1Agent");
    expect(html).toContain("return_to=");
    expect(html).toContain("x1agent</span>");
    expect(auth.headers.get("content-security-policy")).toContain(
      "http://127.0.0.1:*",
    );
  });

  test("issues a code, verifies PKCE, and returns opaque bearer tokens", async () => {
    const { server, cookie } = fixture(true);
    const client = await register(server);
    const params = authParams(client.client_id);
    const consent = await server.request(`/oauth/authorize?${params}`, {
      headers: cookie,
    });
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("Authorize");

    const approved = await server.request("/oauth/authorize", {
      method: "POST",
      headers: {
        ...cookie,
        Origin: authorizationServerUrl,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        consent_token: consentToken(consentHtml),
        decision: "approve",
      }),
    });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.searchParams.get("code")).toBe("one-time-code");
    expect(callback.searchParams.get("state")).toBe("codex-state");

    const token = await server.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: callback.searchParams.get("code")!,
        redirect_uri: "http://127.0.0.1:49200/callback",
        resource: resourceUrl,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      scope: "x1.workspaces.read",
    });
  });

  test("rejects forged or replayed consent approval posts", async () => {
    const { server, cookie } = fixture(true);
    const client = await register(server);
    const consent = await server.request(
      `/oauth/authorize?${authParams(client.client_id)}`,
      { headers: cookie },
    );
    const token = consentToken(await consent.text());
    const body = new URLSearchParams({
      consent_token: token,
      decision: "approve",
    });

    const forged = await server.request("/oauth/authorize", {
      method: "POST",
      headers: {
        ...cookie,
        Origin: "https://evil.preview.example.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(forged.status).toBe(403);

    const approved = await server.request("/oauth/authorize", {
      method: "POST",
      headers: {
        ...cookie,
        Origin: authorizationServerUrl,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(approved.status).toBe(302);

    const replayed = await server.request("/oauth/authorize", {
      method: "POST",
      headers: {
        ...cookie,
        Origin: authorizationServerUrl,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(replayed.status).toBe(400);
  });

  test("bounds and rate-limits dynamic client registration", async () => {
    const { server } = fixture();
    const tooLarge = await server.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        padding: "x".repeat(17 * 1024),
        redirect_uris: ["http://127.0.0.1:49200/callback"],
      }),
    });
    expect(tooLarge.status).toBe(413);

    const oversized = await server.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "x".repeat(201),
        redirect_uris: ["http://127.0.0.1:49200/callback"],
      }),
    });
    expect(oversized.status).toBe(400);

    const { server: limitedServer } = fixture();
    let final: Response | null = null;
    for (let i = 0; i < 20; i += 1) {
      final = await limitedServer.request("/oauth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.9",
        },
        body: JSON.stringify({
          redirect_uris: [`http://127.0.0.1:${49_300 + i}/callback`],
        }),
      });
    }
    expect(final?.status).toBe(201);
    const limited = await limitedServer.request("/oauth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:49999/callback"],
      }),
    });
    expect(limited.status).toBe(429);
  });

  test("serves real workspace tools through authenticated streamable HTTP", async () => {
    const { server } = fixture();
    const request = await server.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer access-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "workspaces.list", arguments: {} },
      }),
    });
    expect(request.status).toBe(200);
    const rpc = (await request.json()) as {
      result: { structuredContent: unknown };
    };
    expect(rpc.result.structuredContent).toEqual({
      workspaces: [
        {
          id: "workspace-1",
          slug: "default",
          name: "Default",
          role: "owner",
          createdAt: "2026-08-03T00:00:00.000Z",
        },
      ],
    });
  });
});
