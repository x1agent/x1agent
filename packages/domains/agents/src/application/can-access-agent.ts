import type { UserId } from "@x1agent/kernel";
import type { Agent, AgentId } from "../domain/agent.js";
import type { AgentGrantRepository } from "../ports/agent-grant-repository.js";
import type { AgentRepository } from "../ports/agent-repository.js";
import type { AgentVerb } from "../domain/grant.js";

export interface AgentAccessSnapshot {
  /** Whether the user can see the agent at all. */
  canView: boolean;
  /** Spawn sessions of this agent. */
  canInvoke: boolean;
  /** Modify prompt/schedule/image/delete. Owner-only by default. */
  canEdit: boolean;
  /** Why we said yes — for debugging + audit. */
  via:
    | "owner"
    | "admin"
    | "visibility_workspace"
    | "grant"
    | "denied";
}

const NONE: AgentAccessSnapshot = {
  canView: false,
  canInvoke: false,
  canEdit: false,
  via: "denied",
};

export interface AccessContext {
  /**
   * "What groups is this user in (across this workspace)?" — caller
   * pre-resolves; the resolver itself doesn't query the groups table.
   * Keeps the resolver pure + cheap to test.
   */
  userGroupIds: readonly string[];
  /** True if the user has any membership in the agent's workspace. */
  isWorkspaceMember: boolean;
  /** True for workspace admin/owner — bypasses every other check. */
  isWorkspaceAdmin: boolean;
}

export interface ResolveAccessDeps {
  agents: AgentRepository;
  grants: AgentGrantRepository;
}

/**
 * "Can `userId` do X with `agentId`?". Walks owner → admin → visibility
 * tier → grant table. Returns the full set of verbs in one round-trip
 * so callers (list filters, invoke gates) can branch without re-asking.
 *
 * Schedule-driven sessions (no human triggering them) hit this with a
 * synthetic actor at the route layer — workspace-admin bypass keeps
 * those visible.
 */
export async function resolveAgentAccess(
  deps: ResolveAccessDeps,
  agentId: AgentId,
  userId: UserId,
  ctx: AccessContext,
): Promise<AgentAccessSnapshot & { agent: Agent | null }> {
  const agent = await deps.agents.findById(agentId);
  if (!agent) return { ...NONE, agent: null };

  if (ctx.isWorkspaceAdmin) {
    return { canView: true, canInvoke: true, canEdit: true, via: "admin", agent };
  }

  if (agent.ownerUserId && agent.ownerUserId === userId) {
    return { canView: true, canInvoke: true, canEdit: true, via: "owner", agent };
  }

  // Visibility tier — covers the common case without consulting the
  // grant table. Edit is NEVER granted by visibility — it's owner /
  // admin / explicit grant only.
  if (agent.visibility === "workspace" && ctx.isWorkspaceMember) {
    return {
      canView: true,
      canInvoke: true,
      canEdit: false,
      via: "visibility_workspace",
      agent,
    };
  }
  if (agent.visibility === "private") {
    return { ...NONE, agent };
  }

  // visibility = 'via_grants' (or 'workspace' but user isn't a member,
  // unusual but technically possible if grants were given to a
  // public/group that includes external users).
  const verbs = await deps.grants.listVerbsForResolver({
    agentId,
    userId,
    userGroupIds: ctx.userGroupIds,
    userIsWorkspaceMember: ctx.isWorkspaceMember,
  });
  if (verbs.size === 0) return { ...NONE, agent };

  // 'view' implied by 'invoke' or 'edit'; collapse into a snapshot.
  const canInvoke = verbs.has("invoke") || verbs.has("edit");
  const canEdit = verbs.has("edit");
  const canView = canInvoke || canEdit || verbs.has("view");
  return { canView, canInvoke, canEdit, via: "grant", agent };
}

/** Convenience predicate when you only care about one verb. */
export async function userHasAgentVerb(
  deps: ResolveAccessDeps,
  agentId: AgentId,
  userId: UserId,
  ctx: AccessContext,
  verb: AgentVerb,
): Promise<boolean> {
  const snap = await resolveAgentAccess(deps, agentId, userId, ctx);
  if (verb === "view") return snap.canView;
  if (verb === "invoke") return snap.canInvoke;
  return snap.canEdit;
}
