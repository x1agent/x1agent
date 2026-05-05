import type { WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "../domain/slack-bot-config.js";

/**
 * Resolves an agent id to its owning workspace id. Used by
 * `pairSlackBot` to enforce that the requested agent belongs to the
 * same workspace as the bot — prevents a workspace-A admin from
 * pairing one of their bots with a workspace-B agent (cross-tenant
 * IDOR).
 *
 * Kept as a domain port rather than reaching into the agents domain
 * directly so the messaging package doesn't pull in a dependency it
 * otherwise has no need for. The postgres adapter is a one-line query.
 */
export interface AgentWorkspaceReader {
  findWorkspaceId(agentId: AgentId): Promise<WorkspaceId | null>;
}
