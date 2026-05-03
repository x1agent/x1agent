/**
 * mcp-oauth-proxy
 *
 * Tiny reverse proxy that runs as a sibling container alongside the
 * agent in a session pod, holding a per-user OAuth bearer for one
 * remote_oauth MCP attachment. The agent talks to this proxy on
 * `localhost:<port>`; the proxy forwards every request to the
 * upstream MCP URL with `Authorization: Bearer <token>` injected.
 *
 * Why a sibling container, not direct config in the agent's
 * mcpServers (which would also work via Anthropic SDK's HTTP MCP
 * support):
 *
 *   The agent container is untrusted. Any prompt injection that
 *   gains shell access reads its env. Putting the bearer in the
 *   agent process defeats Zone-3's "agent never sees the credential"
 *   property. The proxy holds the bearer in its own container's env
 *   (mounted via valueFrom.secretKeyRef) and the agent only sees a
 *   localhost URL with no headers.
 *
 * Env (all required):
 *   MCP_PROXY_TARGET   — upstream URL (e.g. https://mcp.notion.com/mcp)
 *   MCP_PROXY_BEARER   — the access_token for the active user
 *   MCP_PROXY_PORT     — local port to listen on (e.g. 9100)
 *   MCP_PROXY_NAME     — catalog name (for logs only)
 */

const target = required("MCP_PROXY_TARGET");
const bearer = required("MCP_PROXY_BEARER");
const port = Number(required("MCP_PROXY_PORT"));
const proxyName = process.env.MCP_PROXY_NAME ?? "mcp";

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(`MCP_PROXY_PORT must be a valid port number; got '${port}'`);
}
const targetUrl = parseUrl(target);

console.log(
  `[mcp-oauth-proxy] starting name=${proxyName} listen=:${port} target=${targetUrl.origin}${targetUrl.pathname}`,
);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  // Long timeouts — Streamable HTTP / SSE transport keeps the
  // connection open. Bun's default is fine but we make it explicit.
  idleTimeout: 240,
  async fetch(req: Request) {
    if (req.url.endsWith("/healthz") || req.url.endsWith("/health")) {
      return new Response("ok", { status: 200 });
    }
    return forward(req);
  },
});

async function forward(req: Request): Promise<Response> {
  // Construct the upstream URL by replacing the request URL's
  // origin with the target's. Preserve path + query so MCPs that
  // expose multiple endpoints (e.g. /mcp/sse + /mcp/messages) keep
  // working.
  let upstream: URL;
  try {
    const incoming = new URL(req.url);
    upstream = new URL(targetUrl.toString());
    // If the upstream has its own path, prepend it to the incoming
    // path. Most servers expose one path (e.g. /mcp); incoming
    // requests will typically be GET / or POST /. If the agent's
    // claude.json points at http://localhost:9100/ then there's
    // nothing to prepend except the upstream's own path.
    if (incoming.pathname !== "/" && incoming.pathname !== "") {
      // Combine: e.g. target=/mcp, incoming=/messages → /mcp/messages
      const base = upstream.pathname.replace(/\/+$/, "");
      const tail = incoming.pathname.startsWith("/")
        ? incoming.pathname
        : `/${incoming.pathname}`;
      upstream.pathname = `${base}${tail}`;
    }
    upstream.search = incoming.search;
  } catch (err) {
    return new Response(`bad request: ${(err as Error).message}`, {
      status: 400,
    });
  }

  // Strip hop-by-hop headers + any inbound Authorization (the agent
  // shouldn't be setting one; if it does, we override). Forward
  // everything else.
  const headers = new Headers(req.headers);
  for (const h of [
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-authenticate",
  ]) {
    headers.delete(h);
  }
  headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", upstream.host);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // SSE / streaming-friendly: don't buffer.
      redirect: "manual",
      // @ts-expect-error — bun supports this option for streaming bodies.
      duplex: "half",
    });
  } catch (err) {
    console.warn(
      `[mcp-oauth-proxy] upstream fetch failed name=${proxyName}: ${(err as Error).message}`,
    );
    return new Response(
      JSON.stringify({
        error: "upstream_unreachable",
        message: (err as Error).message,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (upstreamRes.status === 401) {
    // The token is bad / expired. Surface this as a structured error
    // the agent can show — we deliberately don't try to refresh
    // here because the api resolved a fresh token at session-start;
    // a 401 mid-session means revocation, not stale.
    console.warn(
      `[mcp-oauth-proxy] upstream 401 name=${proxyName} — token revoked or invalid`,
    );
  }

  // Re-stream the response body. Bun preserves chunked encoding.
  const respHeaders = new Headers(upstreamRes.headers);
  // Drop hop-by-hop headers from upstream too.
  for (const h of ["transfer-encoding", "connection", "keep-alive"]) {
    respHeaders.delete(h);
  }
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: respHeaders,
  });
}

function required(envName: string): string {
  const v = process.env[envName];
  if (!v) fail(`${envName} env is required`);
  return v;
}

function parseUrl(u: string): URL {
  try {
    return new URL(u);
  } catch {
    fail(`MCP_PROXY_TARGET is not a valid URL: ${u}`);
  }
}

function fail(message: string): never {
  console.error(`[mcp-oauth-proxy] ${message}`);
  process.exit(1);
}
