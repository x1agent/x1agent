import type { Email, UserId } from "@x1agent/kernel";

/**
 * Auto-accepts any pending invitations for an email at sign-in time.
 *
 * When a user signs in for the first time and an admin has already
 * sent them an invitation, the user is expected to land in the
 * inviting workspace as a member. Without this port, the access-gate
 * lets them past the domain-allowlist check (because a pending
 * invitation exists) but the invitation itself stays pending — the
 * user shows up authenticated with no workspace memberships and the
 * UI renders a "no workspace access" empty state.
 *
 * The contract is permissive: implementations look up *all* pending,
 * unexpired, unrevoked invitations whose email matches the user's
 * email (case-insensitive) and accept each one, creating a workspace
 * membership per invitation. Already-accepted, revoked, and expired
 * rows are ignored. A user invited to N workspaces becomes a member
 * of all N in one sign-in.
 *
 * The auth domain doesn't know how invitations are stored — the
 * implementation lives in the composition root and is wired against
 * the invitations domain's repositories.
 */
export interface PendingInvitationAcceptor {
  acceptAllFor(userId: UserId, email: Email): Promise<void>;
}
