import { describe, it, expect, beforeEach } from "bun:test";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { createSlackBotConfig } from "./create-slack-bot-config.js";
import {
  FakeSlackManifestBuilder,
  InMemorySlackBotConfigStore,
  InMemorySlackInstallStateStore,
} from "./slack-fakes.js";
import { SlackBotConfigNameTakenError } from "../domain/slack-bot-config.js";

const WORKSPACE = WorkspaceId("11111111-1111-7111-8111-111111111111");
const ACTOR = UserId("22222222-2222-7222-8222-222222222222");

function buildDeps() {
  let counter = 0;
  return {
    configs: new InMemorySlackBotConfigStore(),
    state: new InMemorySlackInstallStateStore(),
    manifest: new FakeSlackManifestBuilder(),
    randomState: () => `state-${++counter}`,
    now: () => new Date("2026-05-05T00:00:00Z"),
  };
}

describe("createSlackBotConfig", () => {
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    deps = buildDeps();
  });

  it("creates a config, mints a state token, and returns the manifest URL", async () => {
    const result = await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "@triage",
      actor: ACTOR,
    });
    expect(result.config.botName as string).toBe("triage");
    expect(result.config.workspaceId).toBe(WORKSPACE);
    expect(result.config.agentId).toBeNull();
    expect(result.state).toBe("state-1");
    expect(result.manifestUrl).toBe(
      "https://api.slack.com/apps?new_app=1&bot=triage",
    );
    expect(deps.state.rows.size).toBe(1);
    const stateRow = deps.state.rows.get("state-1");
    expect(stateRow?.botConfigId).toBe(result.config.id);
    expect(stateRow?.initiatingUserId).toBe(ACTOR);
  });

  it("rejects a duplicate bot name in the same workspace", async () => {
    await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage",
      actor: ACTOR,
    });
    await expect(
      createSlackBotConfig(deps, {
        workspaceId: WORKSPACE,
        rawBotName: "@triage",
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(SlackBotConfigNameTakenError);
  });

  it("permits the same bot name in a different workspace", async () => {
    const other = WorkspaceId("33333333-3333-7333-8333-333333333333");
    await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage",
      actor: ACTOR,
    });
    const result = await createSlackBotConfig(deps, {
      workspaceId: other,
      rawBotName: "triage",
      actor: ACTOR,
    });
    expect(result.config.workspaceId).toBe(other);
  });

  it("propagates an explicit return_to into the state row", async () => {
    const result = await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage",
      actor: ACTOR,
      returnTo: "/workspaces/acme/settings/integrations/slack",
    });
    const stateRow = deps.state.rows.get(result.state);
    expect(stateRow?.returnTo).toBe(
      "/workspaces/acme/settings/integrations/slack",
    );
  });

  it("sets the state row's expiry 10 minutes in the future", async () => {
    const result = await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage",
      actor: ACTOR,
    });
    const stateRow = deps.state.rows.get(result.state);
    expect(stateRow?.expiresAt.getTime()).toBe(
      new Date("2026-05-05T00:10:00Z").getTime(),
    );
  });
});
