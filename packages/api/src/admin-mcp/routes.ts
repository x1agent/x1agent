import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { SessionTokenizer } from "@x1agent/domain-auth";

/**
 * Public, remote MCP authentication boundary.
 *
 * This is deliberately separate from `agent-runtime/x1-mcp.ts`: that
 * server runs inside an agent Job and uses its sidecar credential. This
 * route is the internet-facing resource server for a human-operated MCP
 * client such as Codex.
 *
 * The first slice establishes RFC 9728 / RFC 8414 discovery and gets a
 * client to the x1agent browser authorization boundary. Token issuance and
 * administrative tool dispatch land on this same surface in later slices.
 */
export interface AdminMcpRoutesConfig {
  /** Public MCP resource URL, e.g. https://x1agent.example.com/mcp. */
  resourceUrl: string;
  /** API origin that hosts the OAuth authorization-server endpoints. */
  authorizationServerUrl: string;
  tokenizer: SessionTokenizer;
}

type RegisteredClient = {
  clientId: string;
  redirectUris: string[];
  clientName: string | null;
  createdAt: Date;
};

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
  } catch {
    return false;
  }
}

function mcpChallenge(metadataUrl: string): string {
  return `Bearer realm="x1agent", resource_metadata="${metadataUrl}"`;
}

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header("Cache-Control", "no-store");
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export function createAdminMcpRoutes(cfg: AdminMcpRoutesConfig): Hono {
  const app = new Hono();
  // M0 bootstrap state. Persist this in admin_mcp_oauth_clients before token
  // issuance is enabled; keeping it process-local prevents this incomplete
  // OAuth slice from accidentally becoming a durable production credential
  // store.
  const clients = new Map<string, RegisteredClient>();
  const resourceMetadataUrl = `${cfg.authorizationServerUrl}/.well-known/oauth-protected-resource/mcp`;

  const unauthorized = (c: Context) => {
    noStore(c);
    c.header("WWW-Authenticate", mcpChallenge(resourceMetadataUrl));
    return c.json({ error: "unauthorized" }, 401);
  };

  app.get("/mcp", unauthorized);
  app.post("/mcp", unauthorized);
  app.delete("/mcp", unauthorized);

  // RFC 9728 path-specific discovery for the canonical /mcp resource.
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    noStore(c);
    return c.json({
      resource: cfg.resourceUrl,
      authorization_servers: [cfg.authorizationServerUrl],
      scopes_supported: ["x1.workspaces.read"],
      bearer_methods_supported: ["header"],
    });
  });

  // Root metadata is useful to older clients that use the RFC 9728 fallback.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    noStore(c);
    return c.json({
      resource: cfg.resourceUrl,
      authorization_servers: [cfg.authorizationServerUrl],
      scopes_supported: ["x1.workspaces.read"],
      bearer_methods_supported: ["header"],
    });
  });

  // RFC 8414 authorization-server metadata. Codex currently uses Dynamic
  // Client Registration when it has no preconfigured client identity.
  app.get("/.well-known/oauth-authorization-server", (c) => {
    noStore(c);
    return c.json({
      issuer: cfg.authorizationServerUrl,
      authorization_endpoint: `${cfg.authorizationServerUrl}/oauth/authorize`,
      token_endpoint: `${cfg.authorizationServerUrl}/oauth/token`,
      registration_endpoint: `${cfg.authorizationServerUrl}/oauth/register`,
      revocation_endpoint: `${cfg.authorizationServerUrl}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["x1.workspaces.read"],
    });
  });

  app.post("/oauth/register", async (c) => {
    noStore(c);
    const parsed: unknown = await c.req.json().catch(() => null);
    const body =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri: unknown): uri is string =>
          typeof uri === "string" && isAllowedRedirectUri(uri),
        )
      : [];
    if (redirectUris.length === 0) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    const clientId = `x1mcp_${randomUUID()}`;
    const client: RegisteredClient = {
      clientId,
      redirectUris,
      clientName: typeof body.client_name === "string" ? body.client_name : null,
      createdAt: new Date(),
    };
    clients.set(clientId, client);
    return c.json({
      client_id: clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, 201);
  });

  app.get("/oauth/authorize", (c) => {
    noStore(c);
    const responseType = c.req.query("response_type");
    const clientId = c.req.query("client_id");
    const redirectUri = c.req.query("redirect_uri");
    const resource = c.req.query("resource");
    const challenge = c.req.query("code_challenge");
    const challengeMethod = c.req.query("code_challenge_method");
    const client = clientId ? clients.get(clientId) : undefined;

    if (
      responseType !== "code" || !client || !redirectUri ||
      !client.redirectUris.includes(redirectUri) || resource !== cfg.resourceUrl ||
      !challenge || challengeMethod !== "S256"
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const cookie = c.req.header("Cookie") || "";
    const raw = cookie.match(/(?:^|;\s*)x1_session=([^;]+)/)?.[1];
    const session = raw ? cfg.tokenizer.verify(raw) : null;
    if (!session) {
      // The browser has reached the correct first-party auth boundary. The
      // next slice preserves this validated request through browser sign-in
      // and renders an explicit consent screen before issuing a code.
      return page(
        "Sign in to X1Agent",
        `<p>${client.clientName ?? "This MCP client"} is requesting access to X1Agent.</p><p>Sign in to X1Agent in this browser, then restart the MCP login request.</p><p><a href="/auth/google">Sign in with Google</a></p>`,
      );
    }

    return page(
      "X1Agent MCP authorization",
      `<p>Signed in as ${session.email}.</p><p>${client.clientName ?? "This MCP client"} requested <code>x1.workspaces.read</code>.</p><p>Authorization-code issuance and consent persistence are the next implementation slice.</p>`,
    );
  });

  app.post("/oauth/token", (c) => {
    noStore(c);
    return c.json({ error: "temporarily_unavailable", error_description: "X1Agent MCP token issuance is not enabled yet" }, 503);
  });

  app.post("/oauth/revoke", (c) => {
    noStore(c);
    return c.body(null, 200);
  });

  return app;
}
