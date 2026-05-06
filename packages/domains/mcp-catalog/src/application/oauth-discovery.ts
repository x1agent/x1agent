import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "@x1agent/kernel";

/**
 * RFC 9728 Protected Resource Metadata. Lives at
 * `<resource_url>/.well-known/oauth-protected-resource`.
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  resource_name?: string;
  bearer_methods_supported?: string[];
}

/**
 * RFC 8414 Authorization Server Metadata. Lives at
 * `<authorization_server>/.well-known/oauth-authorization-server`.
 *
 * Required for our flow: authorization_endpoint, token_endpoint,
 * registration_endpoint (DCR is required for x1agent's remote_oauth
 * shape). Optional but used: code_challenge_methods_supported (PKCE),
 * scopes_supported, token_endpoint_auth_methods_supported.
 */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  revocation_endpoint?: string;
}

export interface DiscoveryResult {
  /** URL the operator typed; used as the resource base. */
  inputUrl: string;
  resource: ProtectedResourceMetadata;
  /**
   * The chosen authorization server — when the resource lists multiple,
   * we pick the first. RFC 9728 allows multiples but the spec's intent
   * is a primary one for clients to use.
   */
  authorizationServer: AuthorizationServerMetadata;
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;

/**
 * Block private + reserved address ranges. Operator input drives these
 * fetches; without this, an attacker (or a confused operator) can pivot
 * the api pod into reading the cloud metadata service or other internal
 * hosts (`169.254.169.254` on AWS/GCP, `fd00::/8` for ULA, etc.).
 *
 * RFC 1918 + RFC 4193 + RFC 3927 + RFC 4291 + RFC 6890 ranges. Errs on
 * the side of rejection — there's no legitimate MCP server reachable
 * only at a link-local address.
 */
function isBlockedAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 127) return true;                              // 127.0.0.0/8
    if (a === 169 && b === 254) return true;                 // link-local + AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;       // 100.64.0.0/10 CGNAT
    if (a === 0) return true;                                // 0.0.0.0/8
    if (a >= 224) return true;                               // multicast + reserved
    return false;
  }
  if (isIP(addr) === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1") return true;                        // loopback
    if (lower === "::") return true;                         // unspecified
    if (lower.startsWith("fe80:")) return true;              // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("ff")) return true;                 // multicast
    // IPv4-mapped (::ffff:a.b.c.d)
    const mapped = lower.match(/^::ffff:([\d.]+)$/);
    if (mapped && mapped[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return false;
}

/** Resolve hostname and reject if any A/AAAA record is in a blocked range. */
async function assertHostIsPublic(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError("url", `invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ValidationError("url", "must be http or https");
  }
  // Strip brackets from IPv6 literals.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "ip6-localhost") {
    throw new ValidationError("url", "localhost is not a valid MCP server");
  }
  // If the host is already an IP literal, check it directly. Otherwise
  // resolve and check every record. Reject if anything resolves into a
  // blocked range — defense against DNS rebinding pointing at multiple
  // addresses.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new ValidationError(
        "url",
        "MCP server resolves to a private or reserved address",
      );
    }
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new ValidationError(
      "url",
      `DNS lookup failed for ${host}: ${(err as Error).message}`,
    );
  }
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new ValidationError(
        "url",
        `MCP server resolves to a private or reserved address (${a.address})`,
      );
    }
  }
}

async function fetchJson<T>(
  url: string,
  label: string,
  checkHost: (u: string) => Promise<void>,
): Promise<T> {
  // Walk redirects manually so we can re-validate the host at every hop.
  // Default `redirect: "follow"` would let an attacker host a public URL
  // that 302s into 169.254.169.254 — we'd never see the final hop.
  let current = url;
  let res: Response;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkHost(current);
    try {
      res = await fetch(current, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
    } catch (err) {
      throw new ValidationError(
        "url",
        `${label} fetch failed: ${(err as Error).message}`,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) {
        throw new ValidationError(
          "url",
          `${label} returned ${res.status} with no Location header`,
        );
      }
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok) {
      throw new ValidationError(
        "url",
        `${label} returned HTTP ${res.status} (expected 200)`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new ValidationError(
        "url",
        `${label} returned non-JSON: ${(err as Error).message}`,
      );
    }
    return body as T;
  }
  throw new ValidationError("url", `${label} too many redirects`);
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Two-step OAuth discovery for an MCP resource server.
 *
 * 1. Fetch RFC 9728 protected-resource metadata at
 *    `<inputUrl>/.well-known/oauth-protected-resource`.
 * 2. Resolve the chosen authorization_servers[0] and fetch its RFC 8414
 *    metadata at `<auth_server>/.well-known/oauth-authorization-server`.
 *
 * The catch: many MCP servers expose both the resource and the auth
 * server at the same origin (Mercury, Notion both do). Some put the
 * `/.well-known/...` path at the origin root rather than at the
 * resource path. We try both shapes for robustness.
 */
/**
 * Test seam: production calls `assertHostIsPublic`, which does a real
 * DNS lookup and refuses RFC1918 / link-local / metadata addresses.
 * Tests pass `assertHostAllowed: async () => {}` to skip the check
 * since they mock `fetch` at the URL layer.
 *
 * Do NOT skip this in production code paths — the SSRF guard is
 * load-bearing.
 */
export interface DiscoveryOptions {
  assertHostAllowed?: (url: string) => Promise<void>;
}

export async function discoverMcpServer(
  inputUrl: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const checkHost = options.assertHostAllowed ?? assertHostIsPublic;
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new ValidationError("url", "must be a valid URL");
  }
  // Require https for OAuth — credentials and authorize redirects must
  // not ride over plaintext. Real MCP providers (Mercury, Notion, etc.)
  // are all https; the only reason to allow http would be a local-dev
  // shim, and that's better solved with a self-signed cert.
  if (parsed.protocol !== "https:") {
    throw new ValidationError("url", "must use https");
  }

  // Resource metadata candidates. Per RFC 9728 §3.1, when the resource
  // has a path component the well-known URI is constructed by appending
  // that path *after* the well-known suffix on the origin (the
  // "suffix-on-origin" form). For resources at the origin root, the
  // well-known is just `<origin>/.well-known/oauth-protected-resource`.
  //
  // Real MCP servers don't all do the same thing:
  //   - Sentry uses suffix-on-origin           (https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp)
  //   - Some servers use path-rooted-on-resource (the resource serves the doc itself)
  //   - Some servers expose only the origin root form
  //
  // Try in order: the spec-canonical suffix form first, then the
  // resource-path-rooted form, then origin-root. We dedupe so a
  // root-resource ("/" path) doesn't probe the same URL twice.
  const base = trimTrailingSlash(parsed.toString());
  const origin = parsed.origin;
  const path = parsed.pathname.replace(/\/$/, ""); // strip trailing slash; "" for root
  const resourceCandidates = [
    // RFC 9728 canonical when the resource has a path. Skip when path
    // is empty — that case collapses into the origin-root form below.
    ...(path !== ""
      ? [`${origin}/.well-known/oauth-protected-resource${path}`]
      : []),
    `${base}/.well-known/oauth-protected-resource`,
    `${origin}/.well-known/oauth-protected-resource`,
  ];

  let resource: ProtectedResourceMetadata | null = null;
  let resourceErr: string | null = null;
  for (const candidate of [...new Set(resourceCandidates)]) {
    try {
      resource = await fetchJson<ProtectedResourceMetadata>(
        candidate,
        "protected-resource metadata",
        checkHost,
      );
      break;
    } catch (err) {
      resourceErr = (err as Error).message;
    }
  }
  if (!resource) {
    throw new ValidationError(
      "url",
      resourceErr ?? "could not fetch protected-resource metadata",
    );
  }

  if (
    !Array.isArray(resource.authorization_servers) ||
    resource.authorization_servers.length === 0
  ) {
    throw new ValidationError(
      "url",
      "protected-resource metadata missing authorization_servers",
    );
  }

  const rawAuthServerUrl = resource.authorization_servers[0]!;
  // Validate the URL the resource handed us. The `assertHostIsPublic`
  // call inside fetchJson covers SSRF for the actual fetch, but bad
  // shape (non-https, file://, etc.) should fail fast.
  let authServerParsed: URL;
  try {
    authServerParsed = new URL(rawAuthServerUrl);
  } catch {
    throw new ValidationError(
      "url",
      `protected-resource metadata authorization_servers[0] is not a valid URL: ${rawAuthServerUrl}`,
    );
  }
  if (authServerParsed.protocol !== "https:") {
    throw new ValidationError(
      "url",
      "authorization server URL must use https",
    );
  }
  const authServerUrl = trimTrailingSlash(rawAuthServerUrl);
  const authServerCandidates = [
    `${authServerUrl}/.well-known/oauth-authorization-server`,
    // OIDC discovery fallback some servers use:
    `${authServerUrl}/.well-known/openid-configuration`,
  ];

  let authServer: AuthorizationServerMetadata | null = null;
  let authServerErr: string | null = null;
  for (const candidate of authServerCandidates) {
    try {
      authServer = await fetchJson<AuthorizationServerMetadata>(
        candidate,
        "authorization-server metadata",
        checkHost,
      );
      break;
    } catch (err) {
      authServerErr = (err as Error).message;
    }
  }
  if (!authServer) {
    throw new ValidationError(
      "url",
      authServerErr ?? "could not fetch authorization-server metadata",
    );
  }

  // Validate required endpoints. Without registration_endpoint we
  // can't do DCR — admin would have to paste client credentials
  // manually. v1 doesn't support that path; surface a clear error
  // so we add it deliberately when a non-DCR provider shows up.
  if (typeof authServer.authorization_endpoint !== "string") {
    throw new ValidationError(
      "url",
      "authorization-server metadata missing authorization_endpoint",
    );
  }
  if (typeof authServer.token_endpoint !== "string") {
    throw new ValidationError(
      "url",
      "authorization-server metadata missing token_endpoint",
    );
  }
  if (typeof authServer.registration_endpoint !== "string") {
    throw new ValidationError(
      "url",
      "authorization-server does not advertise registration_endpoint — DCR is required for v1",
    );
  }
  // PKCE check — we'll require S256 for security; warn if absent and
  // fail at registration time.
  const pkce = authServer.code_challenge_methods_supported ?? [];
  if (!pkce.includes("S256")) {
    throw new ValidationError(
      "url",
      "authorization server does not support PKCE S256 — required for v1",
    );
  }

  return {
    inputUrl,
    resource,
    authorizationServer: authServer,
  };
}
