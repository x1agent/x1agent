import type { UserId } from "@x1agent/kernel";
import type {
  SessionShare,
  SessionShareId,
  ShareRole,
} from "../domain/share.js";
import type { SessionId } from "../domain/session.js";

export interface CreateSessionShareInput {
  sessionId: SessionId;
  userId: UserId;
  role: ShareRole;
  sharedBy: UserId;
}

/**
 * Persistence port for session_user_shares. An UPSERT on
 * (session_id, user_id) — re-sharing updates role + sharedBy in place
 * rather than creating a duplicate row.
 */
export interface SessionShareRepository {
  upsert(input: CreateSessionShareInput): Promise<SessionShare>;
  remove(id: SessionShareId): Promise<void>;
  removeForUser(sessionId: SessionId, userId: UserId): Promise<void>;
  listForSession(sessionId: SessionId): Promise<readonly SessionShare[]>;
  /** "Sessions shared TO me" — used to extend session-list visibility. */
  listForUser(userId: UserId): Promise<readonly SessionShare[]>;
  findForUser(
    sessionId: SessionId,
    userId: UserId,
  ): Promise<SessionShare | null>;
}
