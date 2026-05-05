import type { WorkspaceId } from "@x1agent/kernel";
import type { SlackBotConfigStore } from "../ports/slack-bot-config-store.js";
import type { AgentWorkspaceReader } from "../ports/agent-workspace-reader.js";
import {
  type AgentId,
  SlackBotAgentAlreadyPairedError,
  SlackBotAgentNotInWorkspaceError,
  SlackBotAlreadyPairedError,
  SlackBotConfigNotFoundError,
  SlackBotConfigNotInWorkspaceError,
  type SlackBotConfig,
  type SlackBotConfigId,
} from "../domain/slack-bot-config.js";

export interface PairSlackBotDeps {
  configs: SlackBotConfigStore;
  /**
   * Resolves an agent id → its workspace id. Used to enforce
   * cross-workspace isolation: we will not pair a bot in workspace A
   * with an agent in workspace B even if a workspace-A admin requests
   * it. See CLAUDE.md principle 7.
   */
  agents: AgentWorkspaceReader;
}

/**
 * Pair a bot config with an agent. Enforces:
 *   1. The bot belongs to the same workspace as the agent.
 *   2. The bot is currently unpaired (idempotent: re-pair to same agent
 *      is fine, re-pair to a different agent throws).
 *
 * The "must be unpaired" rule is enforced here rather than at the DB
 * layer so we can later relax it to N-bots-per-agent without a
 * migration. The current product call is 1-bot-per-agent for clarity
 * — easier to reason about who replies in Slack when only one bot
 * speaks for a given agent.
 */
export async function pairSlackBot(
  deps: PairSlackBotDeps,
  input: {
    botConfigId: SlackBotConfigId;
    workspaceId: WorkspaceId;
    agentId: AgentId;
  },
): Promise<SlackBotConfig> {
  const existing = await deps.configs.findById(input.botConfigId);
  if (!existing) throw new SlackBotConfigNotFoundError(input.botConfigId);
  if (existing.workspaceId !== input.workspaceId)
    throw new SlackBotConfigNotInWorkspaceError(
      input.botConfigId,
      input.workspaceId,
    );

  if (existing.agentId && existing.agentId !== input.agentId)
    throw new SlackBotAlreadyPairedError(input.botConfigId, existing.agentId);
  if (existing.agentId === input.agentId) return existing;

  // Tenant isolation: even though the bot is in this workspace,
  // we have to verify the *agent* is too. Otherwise a workspace-A
  // admin could pair their bot with a workspace-B agent by passing
  // the foreign agent's UUID in the request body — the FK on
  // agents(id) accepts any uuid in the table.
  const agentWorkspace = await deps.agents.findWorkspaceId(input.agentId);
  if (agentWorkspace !== input.workspaceId)
    throw new SlackBotAgentNotInWorkspaceError(
      input.agentId,
      input.workspaceId,
    );

  // One agent ↔ at most one bot. The forward direction (one bot
  // can only have one agent) is enforced above. This is the inverse
  // — if the agent is already paired with a *different* bot, refuse.
  // Without this check, two bots could route to the same agent and
  // both fire on the same `app_mention`, causing confused dispatch.
  const otherPairing = await deps.configs.findByAgent(input.agentId);
  if (otherPairing && otherPairing.id !== input.botConfigId)
    throw new SlackBotAgentAlreadyPairedError(
      input.agentId,
      otherPairing.id,
    );

  return deps.configs.pair({
    id: input.botConfigId,
    agentId: input.agentId,
  });
}

export async function unpairSlackBot(
  deps: PairSlackBotDeps,
  input: {
    botConfigId: SlackBotConfigId;
    workspaceId: WorkspaceId;
  },
): Promise<SlackBotConfig> {
  const existing = await deps.configs.findById(input.botConfigId);
  if (!existing) throw new SlackBotConfigNotFoundError(input.botConfigId);
  if (existing.workspaceId !== input.workspaceId)
    throw new SlackBotConfigNotInWorkspaceError(
      input.botConfigId,
      input.workspaceId,
    );
  if (existing.agentId === null) return existing;
  return deps.configs.unpair(input.botConfigId);
}
