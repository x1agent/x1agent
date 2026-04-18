import { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import type { AuthProvider } from "../ports/auth-provider.js";
import type { UserRepository } from "../ports/user-repository.js";
import type { SessionTokenizer } from "../ports/session-tokenizer.js";
import type { AuthProfile } from "../domain/auth-profile.js";
import type {
  AuthSession,
  WorkspaceMembership,
} from "../domain/auth-session.js";
import type { User } from "../domain/user.js";
import { InvalidAuthCodeError } from "../domain/errors.js";

export class InMemoryAuthProvider implements AuthProvider {
  readonly id = "fake";
  constructor(private readonly profiles: Map<string, AuthProfile>) {}

  getAuthorizeUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({ redirect_uri: redirectUri });
    if (state) params.set("state", state);
    return `fake://authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<AuthProfile> {
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
    };
    this.users.set(id, user);
    return user;
  }
  async listMemberships(
    userId: UserId,
  ): Promise<readonly WorkspaceMembership[]> {
    return this.memberships.get(userId) ?? [];
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
