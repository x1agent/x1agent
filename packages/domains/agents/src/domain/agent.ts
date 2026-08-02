import { DomainError } from "@x1agent/kernel";
import type { UserId, WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import type { RuntimeType } from "./runtime.js";
import type { AgentKind } from "./kind.js";
import type { CronSchedule } from "./cron-schedule.js";
import type { AgentSkillSource } from "./skill-source.js";

declare const agentIdBrand: unique symbol;
export type AgentId = string & { readonly [agentIdBrand]: true };
export const AgentId = (raw: string): AgentId => raw as AgentId;

/**
 * Agents belong to a workspace. `slug` is unique within the workspace and
 * stable in URLs. `schedule` drives the platform scheduler (cron or macro);
 * null means manual-only invocation.
 */
export interface Agent {
  id: AgentId;
  workspaceId: WorkspaceId;
  slug: WorkspaceSlug;
  name: string;
  runtimeType: RuntimeType;
  /**
   * Pod-lifecycle discriminator — `worker`, `orchestrator`, or `scheduled`.
   * Drives the session Job's `activeDeadlineSeconds`, `restartPolicy`,
   * workspace volume type, and session singleton semantics. See
   * docs/architecture/orchestration.md.
   */
  kind: AgentKind;
  systemPrompt: string;
  heartbeatMd: string;
  schedule: CronSchedule | null;
  isActive: boolean;
  /**
   * References an agent_images row. NULL means "use the platform
   * default (AGENT_IMAGE env)". Pod-spec resolves this to built_ref
   * at launch; the UI renders a picker sourced from the workspace's
   * available images + platform presets.
   */
  imageId: string | null;
  /**
   * Per-agent override for the Claude Code SDK's model id. Null = fall
   * back to the deployment-wide ANTHROPIC_MODEL env. Stored as text;
   * the SDK + Vertex/Anthropic API are the authority on what's valid.
   */
  model: string | null;
  /**
   * Owner — can do everything (view/invoke/edit). Backfilled from
   * created_by during migration; reassignable by workspace admins.
   * NULL means no owner — only workspace admins see the agent.
   */
  ownerUserId: UserId | null;
  /**
   * Coarse visibility tier. private = owner+admins only; workspace =
   * any workspace member can view + invoke; via_grants = consult
   * agent_grants for every non-owner non-admin caller.
   */
  visibility: "private" | "workspace" | "via_grants";
  createdBy: UserId | null;
  /**
   * User the scheduler should impersonate when firing this agent's
   * cron-driven sessions. Drives the per-session triggered_by_user_id
   * — required for any agent that has Zone-3 / remote_oauth MCPs
   * attached, since those MCPs need a per-user OAuth token to mint
   * credentials with.
   *
   * Defaulted to `createdBy` at agent-create time and backfilled the
   * same way for existing rows in migration 044. Reassignable by
   * workspace admins. May be NULL when (a) the original creator left
   * the workspace and a new run-as user hasn't been picked yet, or
   * (b) the agent has no schedule and no remote_oauth MCPs (in which
   * case the field is decorative). Must reference a current member of
   * the agent's workspace; the application layer enforces that.
   */
  scheduledRunAsUserId: UserId | null;
  /**
   * Per-agent override for the agent process's idle timeout, in
   * seconds. NULL = use the platform default (15 min for workers /
   * scheduled, 7 days for orchestrators) resolved in
   * packages/api/src/k8s/job-watcher.ts. Minimum enforced at the
   * write boundary is 30 s; maximum is 7 days (604800 s) so a runaway
   * setting can't strand an agent pod forever.
   */
  idleTimeoutSeconds: number | null;
  /** Public GitHub-hosted Agent Skills installed into every session. */
  skillSources: AgentSkillSource[];
  createdAt: Date;
  updatedAt: Date;
  /**
   * Anchor for the scheduler's next-tick computation. Bumped on
   * every successful tick whether the tick created a new session
   * (worker/scheduled) or injected a heartbeat wake into an
   * existing orchestrator session. Null for agents that have
   * never been scheduled. See migration 019 and
   * docs/architecture/orchestration.md § Scheduler integration.
   */
  lastSchedulerTickAt: Date | null;
}

export class AgentNotFoundError extends DomainError {
  readonly code = "agent_not_found";
  constructor(public readonly id: string) {
    super(`agent ${id} not found`);
  }
}

export class AgentSlugTakenError extends DomainError {
  readonly code = "agent_slug_taken";
  constructor(public readonly slug: string) {
    super(`an agent with slug ${slug} already exists in this workspace`);
  }
}

export class ScheduledRunAsUserNotInWorkspaceError extends DomainError {
  readonly code = "scheduled_run_as_user_not_in_workspace";
  constructor(public readonly userId: string) {
    super(
      `user ${userId} is not a member of this agent's workspace and cannot be set as the scheduled-run-as user`,
    );
  }
}
