import type { UserId } from "@x1agent/kernel";
import { DomainError } from "@x1agent/kernel";
import type { SessionId } from "./session.js";

/**
 * Two access levels:
 *   - viewer       — read session events
 *   - collaborator — read + send input messages
 */
export type ShareRole = "viewer" | "collaborator";

const SHARE_ROLES: readonly ShareRole[] = ["viewer", "collaborator"] as const;

export function isShareRole(v: string): v is ShareRole {
  return (SHARE_ROLES as readonly string[]).includes(v);
}

declare const sessionShareIdBrand: unique symbol;
export type SessionShareId = string & { readonly [sessionShareIdBrand]: true };
export const SessionShareId = (raw: string): SessionShareId =>
  raw as SessionShareId;

/**
 * One row in session_user_shares — an explicit grant of access on a
 * session to a user other than the owner. The owner (sessions.
 * triggered_by_user_id) is implicit and never appears as a row here.
 */
export interface SessionShare {
  id: SessionShareId;
  sessionId: SessionId;
  userId: UserId;
  role: ShareRole;
  sharedBy: UserId;
  createdAt: Date;
}

export class InvalidShareRoleError extends DomainError {
  readonly code = "invalid_share_role";
  constructor(public readonly raw: string) {
    super(`'${raw}' is not a valid share role; expected viewer or collaborator`);
  }
}

export class CannotShareWithSelfError extends DomainError {
  readonly code = "cannot_share_with_self";
  constructor() {
    super("cannot share a session with its own owner");
  }
}
