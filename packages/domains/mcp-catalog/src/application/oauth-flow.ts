import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "@x1agent/kernel";
import type {
  AuthorizationServerMetadata,
} from "./oauth-discovery.js";
import {
  safeFetch as defaultSafeFetch,
  type SafeFetch,
  type SafeFetchResponse,
} from "./ssrf-safe-fetch.js";

/**
 * Authorization Code + PKCE flow primitives for remote_oauth MCPs.
 *
 * The functions here are pure — they don't read from or write to any
 * repository. The Hono routes wire state (cookie / DB) around them.
 */

export interface PkcePair {
  /** The verifier — kept secret on our side until the callback. */
  codeVerifier: string;
  /** The challenge — sent to the auth server in the authorize URL. */
  codeChallenge: string;
  /** Always "S256" — we verified at discovery time the server supports it. */
  codeChallengeMethod: "S256";
}

/** Base64url-encode raw bytes per RFC 7636. */
function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generatePkce(): PkcePair {
  // 32 random bytes → 43-char base64url string. RFC 7636 requires
  // 43..128 chars; 43 is the minimum and what most clients use.
  const codeVerifier = base64url(randomBytes(32));
  const challengeBytes = createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64url(challengeBytes);
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

/**
 * Opaque per-flow state. Random; callback validates against the
 * cookie (or signed JWT) the start route emitted. Defense against
 * cross-site request forgery on the OAuth redirect.
 */
export function generateState(): string {
  return base64url(randomBytes(16));
}

export interface BuildAuthorizeUrlInput {
  authorizationServer: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  pkce: PkcePair;
  state: string;
  /** Defaults to scopes_supported joined; some providers require an explicit subset. */
  scope?: string;
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const { authorizationServer, clientId, redirectUri, pkce, state } = input;
  const u = new URL(authorizationServer.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", pkce.codeChallenge);
  u.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);
  u.searchParams.set("state", state);
  const scope =
    input.scope ?? (authorizationServer.scopes_supported ?? []).join(" ");
  if (scope) u.searchParams.set("scope", scope);
  return u.toString();
}

/**
 * Token endpoint response shape. Per RFC 6749 §5.1; expires_in is
 * SECONDS, refresh_token is optional, scope may be returned narrower
 * than requested.
 */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export type TokenEndpointAuthMethod =
  | "client_secret_basic"
  | "client_secret_post";

export interface OAuthFlowOptions {
  /** Test seam — defaults to the SSRF-safe fetcher. */
  fetcher?: SafeFetch;
  /** Optional logger for upstream error bodies. The body is never
   *  reflected in thrown errors (it can echo submitted secrets), so
   *  server-side logging is the only place to see it. */
  logUpstreamError?: (info: {
    endpoint: string;
    status: number;
    body: string;
  }) => void;
}

/**
 * Thrown when the upstream auth server rejects our credentials
 * (`invalid_client`, `unauthorized_client`) or the registration was
 * invalidated upstream — usually means the DCR client_id we stored at
 * catalog-creation time is no longer accepted. The caller treats this
 * as a signal to wipe the oauth_clients row so the next Connect click
 * triggers self-heal (re-DCR + fresh authorize URL with the new id).
 *
 * Distinct from a "code expired / replay" 401: those carry
 * `invalid_grant` and are user-actionable (try again), not client-
 * rotation events.
 */
export class StaleClientRegistrationError extends Error {
  constructor(
    public readonly upstreamError: string,
    public readonly endpoint: string,
  ) {
    super(`upstream rejected client credentials at ${endpoint}: ${upstreamError}`);
    this.name = "StaleClientRegistrationError";
  }
}

const STALE_CLIENT_ERRORS = new Set([
  "invalid_client",
  "unauthorized_client",
]);

export interface ExchangeCodeInput {
  authorizationServer: AuthorizationServerMetadata;
  clientId: string;
  clientSecret: string;
  /** Method DCR registered the client with — must be honored at every
   * token endpoint call. Servers that registered _post will reject the
   * Basic header, and vice versa. */
  authMethod: TokenEndpointAuthMethod;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

const TOKEN_TIMEOUT_MS = 10_000;

async function postForm(
  url: string,
  body: URLSearchParams,
  authHeader: string | null,
  fetcher: SafeFetch,
): Promise<SafeFetchResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;
  return fetcher(url, {
    method: "POST",
    body: body.toString(),
    headers,
    timeoutMs: TOKEN_TIMEOUT_MS,
  });
}

/**
 * RFC 6749 §2.3.1 + RFC 6749 Appendix B: Basic auth credentials at the
 * token endpoint are application/x-www-form-urlencoded-encoded *then*
 * base64-encoded. URLSearchParams produces the right encoding (treats
 * `!*'()` correctly, unlike encodeURIComponent).
 */
function basicAuth(clientId: string, clientSecret: string): string {
  const encoded = (s: string) =>
    new URLSearchParams({ v: s }).toString().slice(2); // strip "v="
  return (
    "Basic " +
    Buffer.from(`${encoded(clientId)}:${encoded(clientSecret)}`).toString(
      "base64",
    )
  );
}

/**
 * Apply the negotiated token-endpoint auth method to the outgoing
 * request. `client_secret_basic` puts credentials in the Authorization
 * header; `client_secret_post` puts them in the form body. The two are
 * not interchangeable — servers reject whichever one they didn't
 * register for.
 */
function applyAuth(
  authMethod: TokenEndpointAuthMethod,
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
): { authHeader: string | null } {
  if (authMethod === "client_secret_post") {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    return { authHeader: null };
  }
  // For client_secret_basic, the credentials are authenticated solely
  // with HTTP Basic. Although RFC 6749 permits client_id in the body as
  // well, some token endpoints (including Linear's MCP endpoint) reject
  // requests that present the client through more than one method.
  return { authHeader: basicAuth(clientId, clientSecret) };
}

export async function exchangeCodeForTokens(
  input: ExchangeCodeInput,
  options: OAuthFlowOptions = {},
): Promise<TokenResponse> {
  const fetcher = options.fetcher ?? defaultSafeFetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const { authHeader } = applyAuth(
    input.authMethod,
    body,
    input.clientId,
    input.clientSecret,
  );
  const res = await postForm(
    input.authorizationServer.token_endpoint,
    body,
    authHeader,
    fetcher,
  );
  if (!res.ok) {
    // Don't surface upstream body to the user — auth servers sometimes
    // echo submitted secrets in 4xx debug payloads. Log server-side
    // and inspect `error` for self-heal signals.
    const errorCode = await consumeAndLogUpstreamError(
      res,
      input.authorizationServer.token_endpoint,
      options.logUpstreamError,
    );
    if (res.status === 401 && STALE_CLIENT_ERRORS.has(errorCode)) {
      throw new StaleClientRegistrationError(
        errorCode,
        input.authorizationServer.token_endpoint,
      );
    }
    throw new ValidationError(
      "token",
      `code exchange failed: HTTP ${res.status}`,
    );
  }
  const parsed = (await res.json()) as TokenResponse;
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new ValidationError("token", "token endpoint returned no access_token");
  }
  return parsed;
}

/**
 * Consume a 4xx/5xx token-endpoint response, log it server-side via
 * the optional logger, and return the upstream `error` code if the
 * body is JSON. Returns an empty string when the body isn't parseable
 * — the caller treats that as "unknown reason, surface generic 4xx".
 */
async function consumeAndLogUpstreamError(
  res: SafeFetchResponse,
  endpoint: string,
  logUpstreamError?: OAuthFlowOptions["logUpstreamError"],
): Promise<string> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore body-read failures */
  }
  logUpstreamError?.({ endpoint, status: res.status, body });
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}

export interface RefreshTokensInput {
  authorizationServer: AuthorizationServerMetadata;
  clientId: string;
  clientSecret: string;
  authMethod: TokenEndpointAuthMethod;
  refreshToken: string;
}

export async function refreshAccessToken(
  input: RefreshTokensInput,
  options: OAuthFlowOptions = {},
): Promise<TokenResponse> {
  const fetcher = options.fetcher ?? defaultSafeFetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  const { authHeader } = applyAuth(
    input.authMethod,
    body,
    input.clientId,
    input.clientSecret,
  );
  const res = await postForm(
    input.authorizationServer.token_endpoint,
    body,
    authHeader,
    fetcher,
  );
  if (!res.ok) {
    const errorCode = await consumeAndLogUpstreamError(
      res,
      input.authorizationServer.token_endpoint,
      options.logUpstreamError,
    );
    if (res.status === 401 && STALE_CLIENT_ERRORS.has(errorCode)) {
      throw new StaleClientRegistrationError(
        errorCode,
        input.authorizationServer.token_endpoint,
      );
    }
    throw new ValidationError(
      "refresh_token",
      `refresh failed: HTTP ${res.status}`,
    );
  }
  const parsed = (await res.json()) as TokenResponse;
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new ValidationError(
      "refresh_token",
      "refresh response missing access_token",
    );
  }
  return parsed;
}
