import { OAuth2Client } from "google-auth-library";
import { Email } from "@x1agent/kernel";
import type { AuthProvider } from "../../ports/auth-provider.js";
import type { AuthProfile } from "../../domain/auth-profile.js";
import { InvalidAuthCodeError } from "../../domain/errors.js";

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  /** OAuth scopes to request. Defaults to openid/email/profile. */
  scopes?: readonly string[];
}

const DEFAULT_SCOPES = ["openid", "email", "profile"] as const;

/**
 * Google OAuth 2.0 / OIDC AuthProvider. Uses `google-auth-library` for
 * code exchange + ID-token verification. No tokens or secrets leave this
 * class; the caller only ever sees a normalized AuthProfile.
 */
export class GoogleAuthProvider implements AuthProvider {
  readonly id = "google";
  private readonly client: OAuth2Client;
  private readonly scopes: readonly string[];

  constructor(private readonly config: GoogleAuthConfig) {
    this.client = new OAuth2Client(config.clientId, config.clientSecret);
    this.scopes = config.scopes ?? DEFAULT_SCOPES;
  }

  getAuthorizeUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
    });
    if (state) params.set("state", state);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<AuthProfile> {
    let idToken: string;
    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    let scopeString: string | null = null;
    let expiryDateMs: number | null = null;
    try {
      const { tokens } = await this.client.getToken({
        code,
        redirect_uri: redirectUri,
      });
      if (!tokens.id_token) throw new InvalidAuthCodeError("no id_token");
      idToken = tokens.id_token;
      // Capture the OAuth grant for downstream-API access (Drive,
      // Calendar, Gmail, …). access_token always present on success;
      // refresh_token only on first consent or with prompt=consent;
      // scope is space-delimited; expiry_date is epoch ms or null.
      accessToken = tokens.access_token ?? null;
      refreshToken = tokens.refresh_token ?? null;
      scopeString = tokens.scope ?? null;
      expiryDateMs = tokens.expiry_date ?? null;
    } catch (err) {
      if (err instanceof InvalidAuthCodeError) throw err;
      throw new InvalidAuthCodeError((err as Error).message);
    }

    const ticket = await this.client.verifyIdToken({
      idToken,
      audience: this.config.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) {
      throw new InvalidAuthCodeError("invalid id_token payload");
    }

    const profile: AuthProfile = {
      email: Email(payload.email),
      name: payload.name || payload.email.split("@")[0]!,
      avatarUrl: payload.picture ?? null,
      providerUserId: payload.sub,
      providerId: this.id,
    };

    if (accessToken) {
      profile.oauthGrant = {
        providerId: this.id,
        accessToken,
        refreshToken,
        scopesGranted: scopeString
          ? scopeString.split(/\s+/).filter((s) => s.length > 0)
          : [],
        expiresAt: expiryDateMs ? new Date(expiryDateMs) : null,
      };
    }

    return profile;
  }

  /**
   * Exchange a stored refresh token for a fresh access token. Used by
   * the internal user-OAuth-token endpoint when a cached access token
   * is at-or-near expiry.
   *
   * Throws if the refresh fails — caller surfaces the error as
   * permission_required so the user re-authenticates. Don't swallow:
   * an expired/revoked refresh token is a real signal that the grant
   * is gone, and silent retries waste round-trips.
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: Date | null;
  }> {
    const client = new OAuth2Client(
      this.config.clientId,
      this.config.clientSecret,
    );
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) {
      throw new Error("refresh returned no access_token");
    }
    return {
      accessToken: credentials.access_token,
      expiresAt: credentials.expiry_date
        ? new Date(credentials.expiry_date)
        : null,
    };
  }
}
