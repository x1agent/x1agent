import type { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import { NoWorkspaceMembershipError } from "./errors.js";

export interface WorkspaceMembership {
  workspaceId: WorkspaceId;
  slug: string;
  name: string;
  role: Role;
}

export interface AuthSession {
  userId: UserId;
  email: Email;
  name: string;
  memberships: readonly WorkspaceMembership[];
  isPlatformAdmin: boolean;
}

export function assertHasMembership(session: AuthSession): AuthSession {
  // Platform admins can sign in with zero memberships — they're the
  // bootstrap path on a fresh install where no workspace exists yet.
  // The frontend's NoAccessRoot detects this state and routes them to
  // "/workspaces/new" so they can create the first workspace. Without
  // this exemption a fresh install is unreachable: there is no admin
  // who can grant memberships before there are admins who have signed
  // in.
  if (session.memberships.length === 0 && !session.isPlatformAdmin) {
    throw new NoWorkspaceMembershipError(session.email);
  }
  return session;
}
