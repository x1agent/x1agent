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

async function fetchJson<T>(url: string, label: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (err) {
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
): Promise<DiscoveryResult> {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new ValidationError("url", "must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ValidationError("url", "must be http or https");
  }

  // Resource metadata: try the resource-path well-known first
  // (RFC 9728 default), then fall back to origin-rooted.
  const base = trimTrailingSlash(parsed.toString());
  const origin = parsed.origin;
  const resourceCandidates = [
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

  const authServerUrl = trimTrailingSlash(resource.authorization_servers[0]!);
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
