import { Hono, type Context } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SessionTokenizer } from "@x1agent/domain-auth";
import type {
  AdminMcpOAuthStore,
  OAuthClient,
  OAuthPrincipal,
  OAuthTokenSet,
} from "./oauth-store.js";
import type { AdminMcpWorkspaceReader } from "./workspace-reader.js";

const WORKSPACES_READ_SCOPE = "x1.workspaces.read";

export interface AdminMcpRoutesConfig {
  /** Public MCP resource URL, e.g. https://x1agent.example.com/mcp. */
  resourceUrl: string;
  /** API origin that hosts the OAuth authorization-server endpoints. */
  authorizationServerUrl: string;
  tokenizer: SessionTokenizer;
  oauth: AdminMcpOAuthStore;
  workspaces: AdminMcpWorkspaceReader;
  /** Installation kill switch. Keep false unless an operator enables MCP. */
  enabled: boolean;
}

interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  state: string | null;
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
    );
  } catch {
    return false;
  }
}

function mcpChallenge(metadataUrl: string, error?: string): string {
  const suffix = error ? `, error="${error}"` : "";
  return `Bearer realm="x1agent", resource_metadata="${metadataUrl}"${suffix}`;
}

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hidden(name: string, value: string | null): string {
  return value === null
    ? ""
    : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function page(title: string, body: string): Response {
  const logo = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 12 L11 16 L17 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)} · x1agent</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"ss01","cv11"}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;color:#f7f4ed;background:#060504;background-image:radial-gradient(circle at 18% 8%,rgba(125,178,230,.10),transparent 42%),radial-gradient(circle at 88% 28%,rgba(180,140,220,.08),transparent 44%),radial-gradient(circle at 22% 78%,rgba(220,130,100,.09),transparent 46%),radial-gradient(circle at 92% 96%,rgba(220,110,160,.08),transparent 42%)}.shell{width:min(100%,520px)}.brand{display:flex;align-items:center;gap:10px;margin:0 0 16px 4px;color:#f7f4ed;font-weight:650;letter-spacing:-.02em}.brand svg{width:24px;height:24px}.brand span{font-size:16px}main{position:relative;overflow:hidden;border:1px solid #2a2724;border-radius:14px;padding:32px;background:rgba(23,22,26,.96);box-shadow:0 24px 70px rgba(0,0,0,.38)}main:before{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,rgba(125,178,230,.55),rgba(180,140,220,.45),rgba(220,130,100,.45),rgba(220,110,160,.55))}h1{margin:0 0 12px;font-size:22px;line-height:1.25;letter-spacing:-.025em}p{margin:10px 0;color:#b3a99a;font-size:14px;line-height:1.6}code{display:inline-block;padding:2px 6px;border:1px solid #2a2724;border-radius:5px;background:#0e0d0b;color:#f7f4ed;font:12px/1.5 "JetBrains Mono",ui-monospace,monospace}form{display:flex;align-items:center;margin-top:26px;padding-top:22px;border-top:1px solid #2a2724}button,a.button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border-radius:7px;padding:0 15px;font:inherit;font-size:13px;font-weight:600;line-height:1;cursor:pointer;text-decoration:none;transition:background .15s,border-color .15s,transform .15s}button:active,a.button:active{transform:translateY(1px)}.approve{border:1px solid #c2613e;background:#c2613e;color:#fafaf7}.approve:hover{background:#d06c48;border-color:#d06c48}.deny{border:1px solid #3a3631;background:#1d1c20;color:#b3a99a;margin-left:8px}.deny:hover{border-color:#7a7268;color:#f7f4ed}.foot{margin:14px 4px 0;color:#7a7268;font-size:11px;text-align:center}@media(max-width:560px){main{padding:24px}form{align-items:stretch;flex-direction:column;gap:8px}.deny{margin-left:0}}</style></head><body><div class="shell"><div class="brand">${logo}<span>x1agent</span></div><main><h1>${escapeHtml(title)}</h1>${body}</main><div class="foot">Secure authorization · permissions are checked on every request</div></div></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://127.0.0.1:* http://localhost:*; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function readSession(c: Context, tokenizer: SessionTokenizer) {
  const cookie = c.req.header("Cookie") || "";
  const raw = cookie.match(/(?:^|;\s*)x1_session=([^;]+)/)?.[1];
  return raw ? tokenizer.verify(raw) : null;
}

function oauthError(
  c: Context,
  error: string,
  description: string,
  status = 400,
) {
  noStore(c);
  return c.json({ error, error_description: description }, status as 400);
}

function tokenJson(c: Context, tokens: OAuthTokenSet) {
  noStore(c);
  return c.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    scope: tokens.scope,
  });
}

function appendOAuthResult(
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) target.searchParams.set(key, value);
  }
  return target.toString();
}

async function parseAuthorizationRequest(
  values: { get(name: string): string | null },
  cfg: AdminMcpRoutesConfig,
): Promise<AuthorizationRequest | null> {
  const responseType = values.get("response_type");
  const clientId = values.get("client_id");
  const redirectUri = values.get("redirect_uri");
  const resource = values.get("resource");
  const requestedScope = values.get("scope") || WORKSPACES_READ_SCOPE;
  const scope = [...new Set(requestedScope.split(/\s+/).filter(Boolean))]
    .sort()
    .join(" ");
  const codeChallenge = values.get("code_challenge");
  const challengeMethod = values.get("code_challenge_method");
  const client = clientId ? await cfg.oauth.findClient(clientId) : null;

  if (
    responseType !== "code" ||
    !client ||
    !redirectUri ||
    !client.redirectUris.includes(redirectUri) ||
    resource !== cfg.resourceUrl ||
    scope !== WORKSPACES_READ_SCOPE ||
    !codeChallenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) ||
    challengeMethod !== "S256"
  ) {
    return null;
  }
  return {
    client,
    redirectUri,
    resource,
    scope,
    codeChallenge,
    state: values.get("state"),
  };
}

function authorizationFields(request: AuthorizationRequest): string {
  return [
    hidden("response_type", "code"),
    hidden("client_id", request.client.clientId),
    hidden("redirect_uri", request.redirectUri),
    hidden("resource", request.resource),
    hidden("scope", request.scope),
    hidden("code_challenge", request.codeChallenge),
    hidden("code_challenge_method", "S256"),
    hidden("state", request.state),
  ].join("");
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function createMcpServer(
  principal: OAuthPrincipal,
  workspaces: AdminMcpWorkspaceReader,
): Server {
  const server = new Server(
    { name: "x1agent-admin", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use workspaces.list to discover X1Agent workspaces currently enabled for this OAuth identity, then workspaces.get for details. Results always reflect current membership.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "workspaces.list",
        title: "List X1Agent workspaces",
        description:
          "List workspaces that the authenticated user currently belongs to and whose administrators enabled administrative MCP access.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      {
        name: "workspaces.get",
        title: "Get an X1Agent workspace",
        description:
          "Get one MCP-enabled workspace by slug. Returns not_found when it is absent, disabled, or not visible to the current user.",
        inputSchema: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Workspace slug" },
          },
          required: ["slug"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "workspaces.list") {
      const rows = await workspaces.listForUser(principal.userId);
      return toolResult({ workspaces: rows });
    }
    if (request.params.name === "workspaces.get") {
      const args = request.params.arguments;
      const slug =
        args && typeof args.slug === "string" ? args.slug.trim() : "";
      if (!slug) {
        return {
          content: [{ type: "text", text: "slug is required" }],
          isError: true,
        };
      }
      const workspace = await workspaces.getForUser(principal.userId, slug);
      if (!workspace) {
        return {
          content: [{ type: "text", text: `workspace not found: ${slug}` }],
          isError: true,
        };
      }
      return toolResult({ workspace });
    }
    throw new Error(`unknown tool: ${request.params.name}`);
  });
  return server;
}

export function createAdminMcpRoutes(cfg: AdminMcpRoutesConfig): Hono {
  const app = new Hono();
  const resourceMetadataUrl = `${cfg.authorizationServerUrl}/.well-known/oauth-protected-resource/mcp`;

  const unauthorized = (c: Context, error?: string) => {
    noStore(c);
    c.header("WWW-Authenticate", mcpChallenge(resourceMetadataUrl, error));
    return c.json({ error: "unauthorized" }, 401);
  };

  const metadata = () => ({
    resource: cfg.resourceUrl,
    authorization_servers: [cfg.authorizationServerUrl],
    scopes_supported: [WORKSPACES_READ_SCOPE],
    bearer_methods_supported: ["header"],
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    noStore(c);
    return c.json(metadata());
  });
  app.get("/.well-known/oauth-protected-resource", (c) => {
    noStore(c);
    return c.json(metadata());
  });

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
      scopes_supported: [WORKSPACES_READ_SCOPE],
    });
  });

  app.post("/oauth/register", async (c) => {
    noStore(c);
    if (!cfg.enabled) {
      return oauthError(
        c,
        "temporarily_unavailable",
        "X1Agent administrative MCP is disabled",
        503,
      );
    }
    const parsed: unknown = await c.req.json().catch(() => null);
    const body =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const rawUris = body.redirect_uris;
    if (
      !Array.isArray(rawUris) ||
      rawUris.length === 0 ||
      rawUris.length > 10 ||
      rawUris.some(
        (uri) => typeof uri !== "string" || !isAllowedRedirectUri(uri),
      )
    ) {
      return oauthError(
        c,
        "invalid_client_metadata",
        "redirect_uris must contain valid HTTPS or loopback callback URLs",
      );
    }
    const redirectUris = [...new Set(rawUris as string[])];
    const clientName =
      typeof body.client_name === "string"
        ? body.client_name.trim().slice(0, 200) || null
        : null;
    const client = await cfg.oauth.registerClient({ clientName, redirectUris });
    return c.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: WORKSPACES_READ_SCOPE,
      },
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    noStore(c);
    if (!cfg.enabled) {
      return page(
        "X1Agent MCP unavailable",
        "<p>Administrative MCP access is disabled for this installation.</p>",
      );
    }
    const url = new URL(c.req.url);
    const request = await parseAuthorizationRequest(url.searchParams, cfg);
    if (!request)
      return oauthError(
        c,
        "invalid_request",
        "Invalid OAuth authorization request",
      );

    const session = readSession(c, cfg.tokenizer);
    if (!session) {
      const returnTo = `${url.pathname}${url.search}`;
      return page(
        "Sign in to X1Agent",
        `<p>${escapeHtml(request.client.clientName ?? "This MCP client")} is requesting access to X1Agent.</p><p><a class="button approve" href="/auth/google?return_to=${encodeURIComponent(returnTo)}">Sign in with Google</a></p>`,
      );
    }

    return page(
      "X1Agent MCP authorization",
      `<p>Signed in as ${escapeHtml(String(session.email))}.</p><p>${escapeHtml(request.client.clientName ?? "This MCP client")} requested <code>${WORKSPACES_READ_SCOPE}</code>.</p><p>This permits read-only access to workspaces where you are still a member and an administrator has enabled MCP access.</p><form method="post" action="/oauth/authorize">${authorizationFields(request)}<button class="approve" name="decision" value="approve" type="submit">Authorize</button><button class="deny" name="decision" value="deny" type="submit">Deny</button></form>`,
    );
  });

  app.post("/oauth/authorize", async (c) => {
    noStore(c);
    if (!cfg.enabled)
      return oauthError(
        c,
        "temporarily_unavailable",
        "X1Agent administrative MCP is disabled",
        503,
      );
    const form = await c.req.raw.formData().catch(() => null);
    if (!form)
      return oauthError(c, "invalid_request", "Invalid authorization form");
    const values = {
      get: (name: string) => {
        const value = form.get(name);
        return typeof value === "string" ? value : null;
      },
    };
    const request = await parseAuthorizationRequest(values, cfg);
    if (!request)
      return oauthError(
        c,
        "invalid_request",
        "Invalid OAuth authorization request",
      );
    const session = readSession(c, cfg.tokenizer);
    if (!session)
      return oauthError(
        c,
        "login_required",
        "Your X1Agent browser session expired",
        401,
      );

    if (values.get("decision") !== "approve") {
      return c.redirect(
        appendOAuthResult(request.redirectUri, {
          error: "access_denied",
          state: request.state,
        }),
      );
    }
    const code = await cfg.oauth.authorize({
      clientId: request.client.clientId,
      userId: String(session.userId),
      redirectUri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
    });
    return c.redirect(
      appendOAuthResult(request.redirectUri, { code, state: request.state }),
    );
  });

  app.post("/oauth/token", async (c) => {
    noStore(c);
    if (!cfg.enabled)
      return oauthError(
        c,
        "temporarily_unavailable",
        "X1Agent administrative MCP is disabled",
        503,
      );
    const params = new URLSearchParams(await c.req.text());
    const grantType = params.get("grant_type");
    const clientId = params.get("client_id");
    if (!clientId)
      return oauthError(c, "invalid_client", "client_id is required", 401);

    if (grantType === "authorization_code") {
      const code = params.get("code");
      const redirectUri = params.get("redirect_uri");
      const resource = params.get("resource");
      const codeVerifier = params.get("code_verifier");
      if (!code || !redirectUri || !resource || !codeVerifier) {
        return oauthError(
          c,
          "invalid_request",
          "code, redirect_uri, resource, and code_verifier are required",
        );
      }
      const tokens = await cfg.oauth.exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri,
        resource,
        codeVerifier,
      });
      return tokens
        ? tokenJson(c, tokens)
        : oauthError(
            c,
            "invalid_grant",
            "Authorization code is invalid, expired, used, or failed PKCE",
          );
    }

    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      if (!refreshToken)
        return oauthError(c, "invalid_request", "refresh_token is required");
      const tokens = await cfg.oauth.exchangeRefreshToken({
        refreshToken,
        clientId,
        resource: params.get("resource") || undefined,
        scope: params.get("scope") || undefined,
      });
      return tokens
        ? tokenJson(c, tokens)
        : oauthError(
            c,
            "invalid_grant",
            "Refresh token is invalid, expired, revoked, or reused",
          );
    }
    return oauthError(
      c,
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported",
    );
  });

  app.post("/oauth/revoke", async (c) => {
    noStore(c);
    const params = new URLSearchParams(await c.req.text());
    const token = params.get("token");
    if (token) await cfg.oauth.revoke(token);
    // RFC 7009 intentionally returns 200 even for an unknown token.
    return c.body(null, 200);
  });

  app.all("/mcp", async (c) => {
    if (!cfg.enabled) return c.json({ error: "service_unavailable" }, 503);
    const header = c.req.header("Authorization") || "";
    const match = /^Bearer\s+([^\s]+)$/i.exec(header);
    if (!match) return unauthorized(c);
    const principal = await cfg.oauth.verifyAccessToken(
      match[1]!,
      cfg.resourceUrl,
    );
    if (!principal || !principal.scopes.includes(WORKSPACES_READ_SCOPE)) {
      return unauthorized(c, "invalid_token");
    }

    const server = createMcpServer(principal, cfg.workspaces);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw, {
      authInfo: {
        token: match[1]!,
        clientId: principal.clientId,
        scopes: principal.scopes,
        expiresAt: principal.expiresAt,
        resource: new URL(cfg.resourceUrl),
        extra: { userId: principal.userId },
      },
    });
  });

  return app;
}
