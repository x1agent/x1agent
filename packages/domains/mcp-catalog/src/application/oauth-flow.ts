import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "@x1agent/kernel";
import type {
  AuthorizationServerMetadata,
} from "./oauth-discovery.js";

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

export interface ExchangeCodeInput {
  authorizationServer: AuthorizationServerMetadata;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

const TOKEN_TIMEOUT_MS = 10_000;

async function postForm(
  url: string,
  body: URLSearchParams,
  authHeader: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;
  return fetch(url, {
    method: "POST",
    body,
    headers,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
}

function basicAuth(clientId: string, clientSecret: string): string {
  return (
    "Basic " +
    Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")
  );
}

export async function exchangeCodeForTokens(
  input: ExchangeCodeInput,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  // We registered with token_endpoint_auth_method=client_secret_basic
  // (or fell back to _post). Send credentials in the Authorization
  // header per the basic method; servers that want _post will accept
  // it as well in practice.
  const res = await postForm(
    input.authorizationServer.token_endpoint,
    body,
    basicAuth(input.clientId, input.clientSecret),
  );
  if (!res.ok) {
    const txt = await safeText(res);
    throw new ValidationError(
      "token",
      `code exchange failed: HTTP ${res.status}${txt ? `: ${txt}` : ""}`,
    );
  }
  const parsed = (await res.json()) as TokenResponse;
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new ValidationError("token", "token endpoint returned no access_token");
  }
  return parsed;
}

export interface RefreshTokensInput {
  authorizationServer: AuthorizationServerMetadata;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function refreshAccessToken(
  input: RefreshTokensInput,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  const res = await postForm(
    input.authorizationServer.token_endpoint,
    body,
    basicAuth(input.clientId, input.clientSecret),
  );
  if (!res.ok) {
    const txt = await safeText(res);
    throw new ValidationError(
      "refresh_token",
      `refresh failed: HTTP ${res.status}${txt ? `: ${txt}` : ""}`,
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

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return "";
  }
}
