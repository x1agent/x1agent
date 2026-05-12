import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { SessionShareRepository } from "../ports/session-share-repository.js";
import type { Session, SessionId } from "../domain/session.js";

/**
 * Why this file exists
 * ────────────────────
 * Every list/get endpoint that returns a session — or anything derived
 * from a session (events, share artefacts, share grants) — must apply
 * the same visibility rule. Before this helper existed the same three
 * checks were re-implemented per route, sometimes with different
 * branches (admin-only on the Shares index, owner-or-share on the
 * Sessions list). X1A-9 collapses them into one primitive so:
 *
 *  (a) the domain model is easy to follow — one obvious code path,
 *  (b) future extensions (e.g. group-based shares) are an additive `OR`
 *      clause here instead of a sweep across N routes,
 *  (c) we have one place to write the regression test that proves the
 *      rule.
 *
 * The rule itself
 * ───────────────
 * A session is visible to actor `U` when the session's agent lives in
 * workspace `W` AND one of:
 *
 *   1. `U` is a workspace admin/owner of `W`,
 *   2. `U` triggered the session (owner), or
 *   3. an explicit `session_user_shares` row exists for `(session, U)`.
 *
 * The caller MUST have already confirmed the session's agent belongs to
 * the URL-scoped workspace — this helper does not re-do that check, by
 * design, because most callers already do an agent lookup for other
 * reasons (e.g. surfacing the agent slug to the UI). That keeps the
 * helper cheap and the "agent-in-workspace" guard a single obvious
 * line at the call site.
 *
 * Group-based shares (future)
 * ───────────────────────────
 * When group sharing lands, add a fourth branch here (e.g.
 * `await deps.groupShares?.anyMatch(session.id, U)`). The list-mode
 * helper picks up the same extension by returning the actor's group
 * ids alongside the user id; the SQL adapter ORs the group join in.
 */

export type SessionVisibilityReason =
  | "owner"
  | "workspace_admin"
  | "user_share";
// Future: | "group_share"

export interface SessionVisibilityDeps {
  adminGuard: AdminGuard;
  /**
   * Optional. When omitted, the helper degrades to owner+admin only —
   * useful for code paths that genuinely don't need share-table reads
   * (none today, but it keeps the dependency optional in tests).
   */
  shares?: SessionShareRepository;
}

export type SessionVisibilityResult =
  | { visible: true; reason: SessionVisibilityReason }
  | { visible: false };

/**
 * Single source of truth for "can this user read this session?".
 *
 * Caller must have already verified `session.agentId` resolves to an
 * agent whose `workspaceId === workspaceId` — the cross-tenant guard
 * lives at the route boundary, not here.
 */
export async function resolveSessionVisibility(
  deps: SessionVisibilityDeps,
  actor: UserId,
  session: Pick<Session, "id" | "triggeredByUserId">,
  workspaceId: WorkspaceId,
): Promise<SessionVisibilityResult> {
  // Owner check first — cheapest, no I/O, and the most common hit on
  // the workspace-sessions list.
  if (session.triggeredByUserId === actor) {
    return { visible: true, reason: "owner" };
  }

  // Workspace admin/owner — bypass.
  try {
    await deps.adminGuard.assertAdmin(actor, workspaceId);
    return { visible: true, reason: "workspace_admin" };
  } catch {
    // Not admin; fall through to the share-table check.
  }

  if (deps.shares) {
    const share = await deps.shares.findForUser(
      session.id as SessionId,
      actor,
    );
    if (share) return { visible: true, reason: "user_share" };
  }

  return { visible: false };
}

/**
 * Decide whether the actor's list-side queries should run in
 * unfiltered (`all`) or visibility-filtered (`user`) mode for the
 * given workspace.
 *
 * List endpoints pass this directly into their repository call so the
 * SQL branch is chosen by one helper, not duplicated inline.
 *
 * Group-based sharing extension: change the `user` branch to
 * `{ mode: 'user'; userId; groupIds: readonly GroupId[] }` and update
 * the SQL adapter to OR the group-share join. The call sites continue
 * to work unchanged because they don't peek inside the object.
 */
export type SessionListMode =
  | { mode: "all" }
  | { mode: "user"; userId: UserId };

export interface PickSessionListModeDeps {
  adminGuard: AdminGuard;
}

export async function pickSessionListMode(
  deps: PickSessionListModeDeps,
  actor: UserId,
  workspaceId: WorkspaceId,
): Promise<SessionListMode> {
  try {
    await deps.adminGuard.assertAdmin(actor, workspaceId);
    return { mode: "all" };
  } catch {
    return { mode: "user", userId: actor };
  }
}
