import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentRepository } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { SessionShareRepository } from "../ports/session-share-repository.js";
import type { SessionEventRepository } from "../ports/session-event-repository.js";
import type { SessionId } from "../domain/session.js";

/**
 * Inline replacement for X1A-9's `resolveSessionVisibility` helper —
 * the X1A-9 PR is still in review on main. Once it lands, swap callers
 * over and delete this. The shape matches the design discussed in
 * X1A-9: returns `{ ok }` on success or `{ error }` on miss/forbid,
 * with 404-not-403 for cross-tenant existence-hiding.
 *
 * "Visible" = the actor is a member of the session's workspace OR has
 * a `session_user_shares` row granting access. Workspace admins are a
 * superset of members.
 *
 * Returns `{ workspaceId, sessionId }` on success — that's enough for
 * the comment routes to insert the denormalised workspace_id without
 * re-joining.
 */
export interface ShareVisibilityDeps {
  sessions: SessionRepository;
  agents: AgentRepository;
  sessionShares: SessionShareRepository;
  /**
   * "Is this user in this workspace at all?" — true for any role
   * (member, admin, owner). The auth domain owns this answer; we
   * accept it as a closure to avoid a hard dep on @x1agent/domain-auth.
   */
  isWorkspaceMember: (
    userId: UserId,
    workspaceId: WorkspaceId,
  ) => Promise<boolean>;
}

export type SessionVisibilityResult =
  | {
      ok: {
        sessionId: SessionId;
        workspaceId: WorkspaceId;
        /** True when the actor is a workspace member (or admin); false when
         * access is solely via a session_user_shares grant. The route layer
         * uses this to gate workspace-wide listing endpoints. */
        isWorkspaceMember: boolean;
      };
    }
  | { error: "not_found" | "forbidden" };

export async function resolveSessionVisibility(
  deps: ShareVisibilityDeps,
  sessionId: SessionId,
  actorUserId: UserId,
): Promise<SessionVisibilityResult> {
  const session = await deps.sessions.findById(sessionId);
  if (!session) return { error: "not_found" };

  const agent = await deps.agents.findById(session.agentId);
  if (!agent) return { error: "not_found" };

  const wsId = agent.workspaceId;
  const member = await deps.isWorkspaceMember(actorUserId, wsId);
  if (member) {
    return { ok: { sessionId, workspaceId: wsId, isWorkspaceMember: true } };
  }

  const grant = await deps.sessionShares.findForUser(sessionId, actorUserId);
  if (grant) {
    return { ok: { sessionId, workspaceId: wsId, isWorkspaceMember: false } };
  }

  // Cross-tenant + non-grantee: 404 to hide existence. Same pattern as
  // loadScoped in `packages/api/src/shares/routes.ts`.
  return { error: "not_found" };
}

/**
 * Helper for the share-comments path specifically: confirm an
 * `agent.share` event with the given share_id exists on a session the
 * actor can see, and return its share_type. The `agent.share` payload
 * carries the share_type, so we lift it out here once and reuse.
 *
 * Returns `null` when the share isn't found in this session.
 */
export interface FindShareInSessionDeps {
  events: SessionEventRepository;
}

export async function findShareInSession(
  deps: FindShareInSessionDeps,
  sessionId: SessionId,
  shareId: string,
): Promise<{ shareType: string; title: string } | null> {
  // Same approach as the existing shares-listing route: load the
  // session's agent.share events and find the one with matching id.
  // 5000 is the existing repository cap; shares are sparse per session
  // so this is fine without pagination for v1.
  const events = await deps.events.listBySession(sessionId, { limit: 5000 });
  for (const e of events) {
    if (e.type !== "agent.share") continue;
    const payload =
      typeof e.payload === "string"
        ? (JSON.parse(e.payload) as Record<string, unknown>)
        : (e.payload as Record<string, unknown>);
    if (payload.share_id === shareId) {
      return {
        shareType: String(payload.share_type ?? ""),
        title: String(payload.title ?? ""),
      };
    }
  }
  return null;
}
