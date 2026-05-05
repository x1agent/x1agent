import { describe, it, expect, beforeEach } from "bun:test";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { pairSlackBot, unpairSlackBot } from "./pair-slack-bot.js";
import {
  FakeAgentWorkspaceReader,
  InMemorySlackBotConfigStore,
} from "./slack-fakes.js";
import {
  AgentId,
  SlackBotAgentAlreadyPairedError,
  SlackBotAgentNotInWorkspaceError,
  SlackBotAlreadyPairedError,
  SlackBotConfigNotFoundError,
  SlackBotConfigNotInWorkspaceError,
  SlackBotName,
} from "../domain/slack-bot-config.js";

const WORKSPACE_A = WorkspaceId("11111111-1111-7111-8111-111111111111");
const WORKSPACE_B = WorkspaceId("22222222-2222-7222-8222-222222222222");
const AGENT_1 = AgentId("33333333-3333-7333-8333-333333333333");
const AGENT_2 = AgentId("44444444-4444-7444-8444-444444444444");
const ACTOR = UserId("55555555-5555-7555-8555-555555555555");

function buildDeps() {
  const configs = new InMemorySlackBotConfigStore();
  const agents = new FakeAgentWorkspaceReader();
  // Default: every test agent lives in workspace A. Cross-workspace
  // tests override per-test.
  agents.setAgentWorkspace(AGENT_1, WORKSPACE_A);
  agents.setAgentWorkspace(AGENT_2, WORKSPACE_A);
  return { configs, agents };
}

describe("pairSlackBot", () => {
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    deps = buildDeps();
  });

  it("pairs an unpaired bot", async () => {
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    const paired = await pairSlackBot(deps, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    expect(paired.agentId).toBe(AGENT_1);
  });

  it("is idempotent when re-pairing to the same agent", async () => {
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await pairSlackBot(deps, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    const second = await pairSlackBot(deps, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    expect(second.agentId).toBe(AGENT_1);
  });

  it("rejects pairing a bot already paired with a different agent", async () => {
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await pairSlackBot(deps, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    await expect(
      pairSlackBot(deps, {
        botConfigId: bot.id,
        workspaceId: WORKSPACE_A,
        agentId: AGENT_2,
      }),
    ).rejects.toBeInstanceOf(SlackBotAlreadyPairedError);
  });

  it("rejects pairing a bot not in the requested workspace", async () => {
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await expect(
      pairSlackBot(deps, {
        botConfigId: bot.id,
        workspaceId: WORKSPACE_B,
        agentId: AGENT_1,
      }),
    ).rejects.toBeInstanceOf(SlackBotConfigNotInWorkspaceError);
  });

  it("rejects an unknown bot id", async () => {
    await expect(
      pairSlackBot(deps, {
        botConfigId: AgentId("99999999-9999-7999-8999-999999999999") as never,
        workspaceId: WORKSPACE_A,
        agentId: AGENT_1,
      }),
    ).rejects.toBeInstanceOf(SlackBotConfigNotFoundError);
  });

  // --- Cross-workspace tenant isolation regressions ---

  it("rejects pairing a bot in workspace A with an agent in workspace B (cross-tenant IDOR)", async () => {
    // Bot exists in workspace A; agent named in the request belongs to
    // workspace B. A workspace-A admin attempts to pair them. Must be
    // rejected — see CLAUDE.md principle 7.
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    deps.agents.setAgentWorkspace(AGENT_2, WORKSPACE_B);
    await expect(
      pairSlackBot(deps, {
        botConfigId: bot.id,
        workspaceId: WORKSPACE_A,
        agentId: AGENT_2,
      }),
    ).rejects.toBeInstanceOf(SlackBotAgentNotInWorkspaceError);
    // Belt-and-suspenders: verify the bot wasn't mutated.
    const after = await deps.configs.findById(bot.id);
    expect(after?.agentId).toBeNull();
  });

  it("rejects pairing when the target agent is already paired with another bot", async () => {
    // Two bots, both in the same workspace. First bot pairs with AGENT_1.
    // Attempting to pair the second bot with the same agent must be
    // rejected — otherwise both bots fire on the same app_mention.
    const bot1 = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    const bot2 = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("oncall"),
      createdBy: ACTOR,
    });
    await pairSlackBot(deps, {
      botConfigId: bot1.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    await expect(
      pairSlackBot(deps, {
        botConfigId: bot2.id,
        workspaceId: WORKSPACE_A,
        agentId: AGENT_1,
      }),
    ).rejects.toBeInstanceOf(SlackBotAgentAlreadyPairedError);
    // Bot 2 stays unpaired.
    const after = await deps.configs.findById(bot2.id);
    expect(after?.agentId).toBeNull();
  });

  it("rejects pairing when the agent id has no workspace mapping at all", async () => {
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    const ghost = AgentId("66666666-6666-7666-8666-666666666666");
    // ghost agent isn't registered in the FakeAgentWorkspaceReader, so
    // `findWorkspaceId` returns null. Treat that as "not in workspace"
    // — refuses to leak whether the agent might exist elsewhere.
    await expect(
      pairSlackBot(deps, {
        botConfigId: bot.id,
        workspaceId: WORKSPACE_A,
        agentId: ghost,
      }),
    ).rejects.toBeInstanceOf(SlackBotAgentNotInWorkspaceError);
  });
});

describe("unpairSlackBot", () => {
  it("clears the agent_id", async () => {
    const deps = buildDeps();
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await pairSlackBot(deps, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    const result = await unpairSlackBot(deps, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
    });
    expect(result.agentId).toBeNull();
  });

  it("is a no-op on an already-unpaired bot", async () => {
    const deps = buildDeps();
    const bot = await deps.configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    const result = await unpairSlackBot(deps, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
    });
    expect(result.agentId).toBeNull();
  });
});
