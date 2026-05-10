import type { Email, UserId } from "@x1agent/kernel";
import type { User } from "../domain/user.js";
import type { AuthProfile } from "../domain/auth-profile.js";
import type { WorkspaceMembership } from "../domain/auth-session.js";
import type { GitIdentity } from "../domain/git-identity.js";

export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;

  /**
   * Create-or-refresh a user from an external identity profile. Adapters
   * MUST update `lastLoginAt`. Workspace memberships are NEVER touched
   * here — those are managed by the workspaces/invitations domains.
   */
  upsertFromProfile(profile: AuthProfile): Promise<User>;

  /**
   * List the user's active workspace memberships. This lives here (rather
   * than in the workspaces domain) because the auth-session composition
   * needs it during sign-in. Workspaces domain will later expose the
   * canonical implementation and this port will delegate.
   */
  listMemberships(userId: UserId): Promise<readonly WorkspaceMembership[]>;

  /**
   * Account-level git identity for worker commits (X1A-42). Setting
   * `null` clears both columns; the worker then runs without
   * GIT_AUTHOR_* env, which falls back to the platform GitHub App
   * principal (`x1agent[bot]`) for commit attribution. Only the user
   * themselves writes their own value — the api enforces that the
   * authenticated session matches the userId before calling this port.
   */
  setGitIdentity(userId: UserId, identity: GitIdentity | null): Promise<void>;
}
