import { Email } from "@x1agent/kernel";
import type {
  AuthProvider,
  AuthorizeUrlOptions,
  ExchangeCodeOptions,
} from "../../ports/auth-provider.js";
import type { AuthProfile } from "../../domain/auth-profile.js";
import { InvalidAuthCodeError } from "../../domain/errors.js";

export interface DevBypassConfig {
  email: string;
  name: string;
  avatarUrl?: string | null;
  /** Code the adapter accepts. Defaults to "bypass". */
  code?: string;
}

/**
 * Local-only AuthProvider. Returns a fixed profile when the configured
 * code is presented; rejects everything else. Useful for integration
 * tests and running the app without a live Google project.
 *
 * MUST NEVER be wired in production. The composition root gates this on
 * AUTH_BYPASS=true; routes can assert NODE_ENV !== "production" defensively.
 */
export class DevBypassAuthProvider implements AuthProvider {
  readonly id = "dev-bypass";
  private readonly acceptedCode: string;

  constructor(private readonly config: DevBypassConfig) {
    this.acceptedCode = config.code ?? "bypass";
  }

  getAuthorizeUrl(
    redirectUri: string,
    state?: string,
    _options?: AuthorizeUrlOptions,
  ): string {
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      code: this.acceptedCode,
    });
    if (state) params.set("state", state);
    return `${redirectUri}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    _redirectUri?: string,
    _options?: ExchangeCodeOptions,
  ): Promise<AuthProfile> {
    if (code !== this.acceptedCode) {
      throw new InvalidAuthCodeError("bypass code mismatch");
    }
    return {
      email: Email(this.config.email),
      name: this.config.name,
      avatarUrl: this.config.avatarUrl ?? null,
      providerUserId: `dev-bypass::${this.config.email.toLowerCase()}`,
      providerId: this.id,
    };
  }
}
