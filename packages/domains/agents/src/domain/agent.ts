import { DomainError } from "@x1agent/kernel";
import type {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { RuntimeType } from "./runtime.js";
import type { CronSchedule } from "./cron-schedule.js";

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
  createdBy: UserId | null;
  createdAt: Date;
  updatedAt: Date;
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
