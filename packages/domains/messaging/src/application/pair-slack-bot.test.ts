import { describe, it, expect, beforeEach } from "bun:test";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { pairSlackBot, unpairSlackBot } from "./pair-slack-bot.js";
import { InMemorySlackBotConfigStore } from "./slack-fakes.js";
import {
  AgentId,
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

describe("pairSlackBot", () => {
  let configs: InMemorySlackBotConfigStore;

  beforeEach(() => {
    configs = new InMemorySlackBotConfigStore();
  });

  it("pairs an unpaired bot", async () => {
    const bot = await configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    const paired = await pairSlackBot({ configs }, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    expect(paired.agentId).toBe(AGENT_1);
  });

  it("is idempotent when re-pairing to the same agent", async () => {
    const bot = await configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await pairSlackBot({ configs }, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    const second = await pairSlackBot({ configs }, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    expect(second.agentId).toBe(AGENT_1);
  });

  it("rejects pairing a bot already paired with a different agent", async () => {
    const bot = await configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await pairSlackBot({ configs }, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    await expect(
      pairSlackBot({ configs }, {
        botConfigId: bot.id,
        workspaceId: WORKSPACE_A,
        agentId: AGENT_2,
      }),
    ).rejects.toBeInstanceOf(SlackBotAlreadyPairedError);
  });

  it("rejects pairing a bot not in the requested workspace", async () => {
    const bot = await configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await expect(
      pairSlackBot({ configs }, {
        botConfigId: bot.id,
        workspaceId: WORKSPACE_B,
        agentId: AGENT_1,
      }),
    ).rejects.toBeInstanceOf(SlackBotConfigNotInWorkspaceError);
  });

  it("rejects an unknown bot id", async () => {
    await expect(
      pairSlackBot({ configs }, {
        botConfigId: AgentId("99999999-9999-7999-8999-999999999999") as never,
        workspaceId: WORKSPACE_A,
        agentId: AGENT_1,
      }),
    ).rejects.toBeInstanceOf(SlackBotConfigNotFoundError);
  });
});

describe("unpairSlackBot", () => {
  it("clears the agent_id", async () => {
    const configs = new InMemorySlackBotConfigStore();
    const bot = await configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    await pairSlackBot({ configs }, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
      agentId: AGENT_1,
    });
    const result = await unpairSlackBot({ configs }, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
    });
    expect(result.agentId).toBeNull();
  });

  it("is a no-op on an already-unpaired bot", async () => {
    const configs = new InMemorySlackBotConfigStore();
    const bot = await configs.create({
      workspaceId: WORKSPACE_A,
      botName: SlackBotName("triage"),
      createdBy: ACTOR,
    });
    const result = await unpairSlackBot({ configs }, {
      botConfigId: bot.id,
      workspaceId: WORKSPACE_A,
    });
    expect(result.agentId).toBeNull();
  });
});
