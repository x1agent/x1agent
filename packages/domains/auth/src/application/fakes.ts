import { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  AuthProvider,
  AuthorizeUrlOptions,
  ExchangeCodeOptions,
} from "../ports/auth-provider.js";
import type { UserRepository } from "../ports/user-repository.js";
import type { SessionTokenizer } from "../ports/session-tokenizer.js";
import type { AuthProfile } from "../domain/auth-profile.js";
import type {
  AuthSession,
  WorkspaceMembership,
} from "../domain/auth-session.js";
import type { User } from "../domain/user.js";
import type { GitIdentity } from "../domain/git-identity.js";
import { InvalidAuthCodeError } from "../domain/errors.js";

export class InMemoryAuthProvider implements AuthProvider {
  readonly id = "fake";
  /** Test inspector: codeVerifier last seen on exchangeCode, or null. */
  lastCodeVerifier: string | null = null;
  /** Test inspector: codeChallenge last seen on getAuthorizeUrl, or null. */
  lastCodeChallenge: string | null = null;
  /**
   * Per-code verifier expectation. When set for a given code, the
   * exchange throws if the supplied verifier doesn't match. Lets tests
   * simulate "PKCE verifier mismatch" without standing up real Google.
   */
  readonly expectedVerifierByCode = new Map<string, string>();

  constructor(private readonly profiles: Map<string, AuthProfile>) {}

  getAuthorizeUrl(
    redirectUri: string,
    state?: string,
    options?: AuthorizeUrlOptions,
  ): string {
    const params = new URLSearchParams({ redirect_uri: redirectUri });
    if (state) params.set("state", state);
    if (options?.codeChallenge) {
      params.set("code_challenge", options.codeChallenge);
      params.set(
        "code_challenge_method",
        options.codeChallengeMethod ?? "S256",
      );
      this.lastCodeChallenge = options.codeChallenge;
    }
    return `fake://authorize?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    _redirectUri?: string,
    options?: ExchangeCodeOptions,
  ): Promise<AuthProfile> {
    this.lastCodeVerifier = options?.codeVerifier ?? null;
    const expected = this.expectedVerifierByCode.get(code);
    if (expected !== undefined && expected !== options?.codeVerifier) {
      throw new InvalidAuthCodeError("pkce verifier mismatch");
    }
    const p = this.profiles.get(code);
    if (!p) throw new InvalidAuthCodeError();
    return p;
  }
}

let idCounter = 1;
function nextUuid(): string {
  const n = (idCounter++).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, User>();
  readonly memberships = new Map<string, WorkspaceMembership[]>();

  async findById(id: UserId): Promise<User | null> {
    return this.users.get(id) ?? null;
  }
  async findByEmail(email: Email): Promise<User | null> {
    for (const u of this.users.values()) if (u.email === email) return u;
    return null;
  }
  async upsertFromProfile(profile: AuthProfile): Promise<User> {
    for (const u of this.users.values()) {
      if (u.email === profile.email) {
        const updated: User = {
          ...u,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        };
        this.users.set(u.id, updated);
        return updated;
      }
    }
    const id = UserId(nextUuid());
    const user: User = {
      id,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      isActive: true,
      gitIdentity: null,
      timezone: null,
    };
    this.users.set(id, user);
    return user;
  }
  async listMemberships(
    userId: UserId,
  ): Promise<readonly WorkspaceMembership[]> {
    return this.memberships.get(userId) ?? [];
  }
  async setGitIdentity(
    userId: UserId,
    identity: GitIdentity | null,
  ): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    this.users.set(userId, { ...u, gitIdentity: identity });
  }
  async setTimezone(userId: UserId, timezone: string | null): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    this.users.set(userId, { ...u, timezone });
  }

  seedMembership(userId: UserId, slug: string, name: string, role: Role) {
    const list = this.memberships.get(userId) ?? [];
    list.push({
      workspaceId: WorkspaceId(nextUuid()),
      slug,
      name,
      role,
    });
    this.memberships.set(userId, list);
  }
}

export class InMemorySessionTokenizer implements SessionTokenizer {
  private readonly prefix = "fake-token::";
  sign(session: AuthSession): string {
    return this.prefix + JSON.stringify(session);
  }
  verify(token: string): AuthSession | null {
    if (!token.startsWith(this.prefix)) return null;
    try {
      return JSON.parse(token.slice(this.prefix.length)) as AuthSession;
    } catch {
      return null;
    }
  }
}
