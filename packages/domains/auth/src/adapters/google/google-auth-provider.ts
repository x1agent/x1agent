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
    try {
      const { tokens } = await this.client.getToken({
        code,
        redirect_uri: redirectUri,
      });
      if (!tokens.id_token) throw new InvalidAuthCodeError("no id_token");
      idToken = tokens.id_token;
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

    return {
      email: Email(payload.email),
      name: payload.name || payload.email.split("@")[0]!,
      avatarUrl: payload.picture ?? null,
      providerUserId: payload.sub,
      providerId: this.id,
    };
  }
}
