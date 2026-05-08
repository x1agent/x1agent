/**
 * User-OAuth credential helper for the google-workspace provider.
 *
 * The provider deployment never sees plaintext OAuth tokens at rest —
 * for each outbound Google API call it asks the api's internal
 * `/api/internal/user-oauth-token` endpoint for a fresh access token,
 * uses it once, and forgets it. Same shape as the sidecar's
 * `user_tokens.rs` helper, just from out-of-pod code.
 *
 * The api refreshes the access token when it's at-or-near expiry, so
 * provider code doesn't have to track expiry itself — it just asks
 * before each call.
 *
 * Errors are tagged so handler code can map them to clean wire
 * responses (permission_required is the load-bearing case the agent
 * surfaces to the operator).
 */

const API_URL = process.env.X1_API_URL ?? "http://api:30001";
const INTERNAL_TOKEN = process.env.API_INTERNAL_TOKEN ?? "";

if (!INTERNAL_TOKEN) {
  console.error(
    "[google-workspace] API_INTERNAL_TOKEN unset — every credential request will 401",
  );
}

export interface MintTokenResult {
  accessToken: string;
  /** ISO-8601 string, or null if the api couldn't determine an expiry. */
  expiresAt: string | null;
}

export class CredentialError extends Error {
  constructor(
    public readonly kind:
      | "permission_required"
      | "unauthorized"
      | "disabled"
      | "transport"
      | "api_error",
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

/**
 * Mint a fresh Google access token for `userId` with the requested
 * `scope` (e.g. `https://www.googleapis.com/auth/drive.readonly`).
 * Throws CredentialError on any non-2xx; caller maps to a wire reply.
 */
export async function mintGoogleToken(
  userId: string,
  scope: string,
): Promise<MintTokenResult> {
  const url = new URL(
    "/api/internal/user-oauth-token",
    API_URL.endsWith("/") ? API_URL : API_URL + "/",
  );
  url.searchParams.set("user_id", userId);
  url.searchParams.set("provider", "google");
  url.searchParams.set("scope", scope);

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "X-Internal-Token": INTERNAL_TOKEN },
    });
  } catch (err) {
    throw new CredentialError(
      "transport",
      `api unreachable: ${(err as Error).message}`,
    );
  }

  const bodyText = await resp.text();
  if (resp.ok) {
    let parsed: { access_token: string; expires_at: string | null };
    try {
      parsed = JSON.parse(bodyText) as typeof parsed;
    } catch (err) {
      throw new CredentialError(
        "api_error",
        `api response invalid json: ${(err as Error).message}`,
        resp.status,
      );
    }
    if (!parsed.access_token) {
      throw new CredentialError(
        "api_error",
        "api response missing access_token",
        resp.status,
      );
    }
    return {
      accessToken: parsed.access_token,
      expiresAt: parsed.expires_at,
    };
  }

  let errorCode = "api_error";
  let errorMessage = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: string;
      message?: string;
    };
    errorCode = parsed.error ?? errorCode;
    errorMessage = parsed.message ?? errorMessage;
  } catch {
    // body wasn't JSON — keep the raw text as the message
  }

  if (resp.status === 401) {
    throw new CredentialError("unauthorized", errorMessage, 401);
  }
  if (resp.status === 403 && errorCode === "permission_required") {
    throw new CredentialError("permission_required", errorMessage, 403);
  }
  if (resp.status === 503) {
    throw new CredentialError("disabled", errorMessage, 503);
  }
  throw new CredentialError("api_error", errorMessage, resp.status);
}
