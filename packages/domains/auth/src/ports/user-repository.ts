import type { Email, UserId } from "@x1agent/kernel";
import type { User } from "../domain/user.js";
import type { AuthProfile } from "../domain/auth-profile.js";
import type { WorkspaceMembership } from "../domain/auth-session.js";

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
}
