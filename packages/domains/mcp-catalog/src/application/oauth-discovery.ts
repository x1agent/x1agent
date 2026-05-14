import { ValidationError } from "@x1agent/kernel";
import {
  safeFetch as defaultSafeFetch,
  type SafeFetch,
} from "./ssrf-safe-fetch.js";

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

/**
 * Test seam: in production, `safeFetch` does the full SSRF guard —
 * URL parse, https-only, DNS lookup, RFC 1918/4193/3927/4291/6890
 * allowlist, IP pinning at connect time, manual redirect re-validation.
 * Unit tests inject a stub fetcher that returns canned responses.
 *
 * Do NOT skip this in production code paths — the SSRF guard is
 * load-bearing.
 */
export interface DiscoveryOptions {
  fetcher?: SafeFetch;
}

async function fetchJson<T>(
  url: string,
  label: string,
  fetcher: SafeFetch,
): Promise<T> {
  let res;
  try {
    res = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      "url",
      `${label} fetch failed: ${(err as Error).message}`,
    );
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
export async function discoverMcpServer(
  inputUrl: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const fetcher = options.fetcher ?? defaultSafeFetch;
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
        fetcher,
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
  // Validate the URL the resource handed us. The safeFetch inside
  // fetchJson covers SSRF for the actual fetch, but bad shape
  // (non-https, file://, etc.) should fail fast.
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
        fetcher,
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
