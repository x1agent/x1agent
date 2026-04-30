import { DomainError, type Subject } from "@x1agent/kernel";

/**
 * Three verbs an agent grant can carry. The owner has all three
 * implicitly; workspace admins/owners bypass the grant table.
 *
 *   view   — see the agent in lists, read its prompt + history
 *   invoke — spawn sessions of this agent
 *   edit   — change prompt, schedule, image, or delete
 */
export type AgentVerb = "view" | "invoke" | "edit";
const VERBS: readonly AgentVerb[] = ["view", "invoke", "edit"] as const;

export function isAgentVerb(v: string): v is AgentVerb {
  return (VERBS as readonly string[]).includes(v);
}

declare const agentGrantIdBrand: unique symbol;
export type AgentGrantId = string & { readonly [agentGrantIdBrand]: true };
export const AgentGrantId = (raw: string): AgentGrantId =>
  raw as AgentGrantId;

import type { AgentId } from "./agent.js";
import type { UserId } from "@x1agent/kernel";

export interface AgentGrant {
  id: AgentGrantId;
  agentId: AgentId;
  subject: Subject;
  verb: AgentVerb;
  grantedBy: UserId;
  createdAt: Date;
}

export class InvalidAgentVerbError extends DomainError {
  readonly code = "invalid_agent_verb";
  constructor(public readonly raw: string) {
    super(
      `'${raw}' is not a valid agent verb; expected view | invoke | edit`,
    );
  }
}

export class NotAgentOwnerError extends DomainError {
  readonly code = "not_agent_owner";
  constructor() {
    super(
      "only the agent's owner or a workspace admin can manage grants",
    );
  }
}

/**
 * Coarse visibility tier on the agent itself. Drives the default
 * answer for users without an explicit grant.
 *
 *   private    — only the owner + workspace admins.
 *   workspace  — every workspace member can view + invoke.
 *   via_grants — agent_grants is the source of truth; no implicit access.
 */
export type AgentVisibility = "private" | "workspace" | "via_grants";

export function isAgentVisibility(v: string): v is AgentVisibility {
  return v === "private" || v === "workspace" || v === "via_grants";
}
