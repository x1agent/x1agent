import { ValidationError } from "@x1agent/kernel";
import type { AuthorizationServerMetadata } from "./oauth-discovery.js";

/**
 * RFC 7591 Dynamic Client Registration request body.
 *
 * We only send the minimum a typical MCP server expects:
 *   * client_name — human-readable, shown on the user's consent screen.
 *   * redirect_uris — where the auth server will send the code.
 *   * grant_types — authorization_code + refresh_token.
 *   * response_types — code (only).
 *   * token_endpoint_auth_method — picked from server capabilities,
 *     defaulting to client_secret_basic.
 *   * scope — joined from server's scopes_supported (so we get
 *     everything the server advertises). Operators can narrow at
 *     attach time later (out of scope for this slice).
 */
interface DCRRequest {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

interface DCRResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
}

const DCR_TIMEOUT_MS = 8_000;

export interface RegisterClientInput {
  /** Cached metadata from discovery — provides registration_endpoint. */
  authorizationServer: AuthorizationServerMetadata;
  /** Where the user will be sent after consent. Must match the value the
   * api uses at `/auth/mcp/:slug/:name/callback` time. */
  redirectUri: string;
  /** Display name shown on the auth server's consent UI. */
  clientName: string;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  /** The token-endpoint auth method DCR was registered with — must be
   * the same method used at every code-exchange/refresh. RFC 6749
   * §2.3.1 lets the server pick which method it accepts. */
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
}

export async function registerOAuthClient(
  input: RegisterClientInput,
): Promise<RegisteredClient> {
  const { authorizationServer, redirectUri, clientName } = input;
  if (!authorizationServer.registration_endpoint) {
    throw new ValidationError(
      "registration",
      "authorization server does not advertise a registration_endpoint",
    );
  }
  const supportedAuth =
    authorizationServer.token_endpoint_auth_methods_supported ?? [];
  // Prefer client_secret_basic per RFC; fall back to client_secret_post.
  // We do NOT register with `none` because v1 requires a confidential
  // client and we want the secret stored on our side.
  const tokenAuth = supportedAuth.includes("client_secret_basic")
    ? "client_secret_basic"
    : supportedAuth.includes("client_secret_post")
      ? "client_secret_post"
      : "client_secret_basic";

  const scopes = (authorizationServer.scopes_supported ?? []).join(" ");

  const body: DCRRequest = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: tokenAuth,
    ...(scopes ? { scope: scopes } : {}),
  };

  let res: Response;
  try {
    res = await fetch(authorizationServer.registration_endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(DCR_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ValidationError(
      "registration",
      `DCR fetch failed: ${(err as Error).message}`,
    );
  }
  if (res.status !== 201 && res.status !== 200) {
    let details = "";
    try {
      details = `: ${await res.text()}`;
    } catch {
      /* ignore */
    }
    throw new ValidationError(
      "registration",
      `DCR returned HTTP ${res.status}${details}`,
    );
  }

  let parsed: DCRResponse;
  try {
    parsed = (await res.json()) as DCRResponse;
  } catch (err) {
    throw new ValidationError(
      "registration",
      `DCR response not JSON: ${(err as Error).message}`,
    );
  }

  if (typeof parsed.client_id !== "string" || parsed.client_id.length === 0) {
    throw new ValidationError(
      "registration",
      "DCR response missing client_id",
    );
  }
  if (
    typeof parsed.client_secret !== "string" ||
    parsed.client_secret.length === 0
  ) {
    throw new ValidationError(
      "registration",
      "DCR response missing client_secret — v1 requires a confidential client",
    );
  }

  return {
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
    tokenEndpointAuthMethod: tokenAuth as
      | "client_secret_basic"
      | "client_secret_post",
  };
}
