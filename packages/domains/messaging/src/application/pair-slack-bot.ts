import type { WorkspaceId } from "@x1agent/kernel";
import type { SlackBotConfigStore } from "../ports/slack-bot-config-store.js";
import {
  type AgentId,
  SlackBotAlreadyPairedError,
  SlackBotConfigNotFoundError,
  SlackBotConfigNotInWorkspaceError,
  type SlackBotConfig,
  type SlackBotConfigId,
} from "../domain/slack-bot-config.js";

export interface PairSlackBotDeps {
  configs: SlackBotConfigStore;
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
