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
  if (session.memberships.length === 0) {
    throw new NoWorkspaceMembershipError(session.email);
  }
  return session;
}
