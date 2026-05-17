import type postgres from "postgres";
import { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import type { UserRepository } from "../../ports/user-repository.js";
import type { User } from "../../domain/user.js";
import type { AuthProfile } from "../../domain/auth-profile.js";
import type { WorkspaceMembership } from "../../domain/auth-session.js";
import type { GitIdentity } from "../../domain/git-identity.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  is_active: boolean;
  git_name: string | null;
  git_email: string | null;
  timezone: string | null;
}

interface MembershipRow {
  workspace_id: string;
  slug: string;
  name: string;
  role: string;
}

function toUser(r: UserRow): User {
  // git_name / git_email are independent columns; we only surface a
  // GitIdentity when both are populated. A half-set row (one column
  // null, the other populated) is treated as "unset" — the api won't
  // generate that shape (the form requires both), but be defensive.
  const gitIdentity: GitIdentity | null =
    r.git_name && r.git_email
      ? { name: r.git_name, email: r.git_email }
      : null;
  return {
    id: UserId(r.id),
    email: Email(r.email),
    name: r.name,
    avatarUrl: r.avatar_url,
    isActive: r.is_active,
    gitIdentity,
    timezone: r.timezone,
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly sql: Sql) {}

  async findById(id: UserId): Promise<User | null> {
    const rows = await this.sql<UserRow[]>`
      SELECT id, email, name, avatar_url, is_active, git_name, git_email, timezone
      FROM users WHERE id = ${id}
    `;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findByEmail(email: Email): Promise<User | null> {
    const rows = await this.sql<UserRow[]>`
      SELECT id, email, name, avatar_url, is_active, git_name, git_email, timezone
      FROM users WHERE lower(email) = ${email}
    `;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async upsertFromProfile(profile: AuthProfile): Promise<User> {
    const rows = await this.sql<UserRow[]>`
      INSERT INTO users (email, name, avatar_url, google_sub, last_login_at)
      VALUES (${profile.email}, ${profile.name}, ${profile.avatarUrl},
              ${profile.providerId === "google" ? profile.providerUserId : null},
              now())
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        avatar_url = EXCLUDED.avatar_url,
        google_sub = COALESCE(users.google_sub, EXCLUDED.google_sub),
        last_login_at = now(),
        updated_at = now()
      RETURNING id, email, name, avatar_url, is_active, git_name, git_email, timezone
    `;
    return toUser(rows[0]!);
  }

  async setGitIdentity(
    userId: UserId,
    identity: GitIdentity | null,
  ): Promise<void> {
    // Single UPDATE so a clear (NULL on both columns) and a set (both
    // columns) ride the same code path. The DB CHECK constraints from
    // migration 046 reject control characters / oversized values
    // defensively; the application layer's parseGitIdentity is the
    // primary gate.
    await this.sql`
      UPDATE users
         SET git_name = ${identity?.name ?? null},
             git_email = ${identity?.email ?? null},
             updated_at = now()
       WHERE id = ${userId}
    `;
  }

  async setTimezone(userId: UserId, timezone: string | null): Promise<void> {
    await this.sql`
      UPDATE users
         SET timezone = ${timezone},
             updated_at = now()
       WHERE id = ${userId}
    `;
  }

  async listMemberships(
    userId: UserId,
  ): Promise<readonly WorkspaceMembership[]> {
    const rows = await this.sql<MembershipRow[]>`
      SELECT w.id AS workspace_id, w.slug, w.name, wm.role
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${userId}
      ORDER BY w.name
    `;
    return rows.map((r) => ({
      workspaceId: WorkspaceId(r.workspace_id),
      slug: r.slug,
      name: r.name,
      role: Role(r.role),
    }));
  }
}
