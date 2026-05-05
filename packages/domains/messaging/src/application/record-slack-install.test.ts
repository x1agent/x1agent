import { describe, it, expect, beforeEach } from "bun:test";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { recordSlackInstall } from "./record-slack-install.js";
import { createSlackBotConfig } from "./create-slack-bot-config.js";
import {
  FakeSlackManifestBuilder,
  FakeSlackOAuthClient,
  InMemorySlackBotConfigStore,
  InMemorySlackInstallStateStore,
  InMemorySlackInstallStore,
} from "./slack-fakes.js";
import {
  SlackInstallAttemptInvalidError,
} from "../domain/slack-install.js";

const WORKSPACE = WorkspaceId("11111111-1111-7111-8111-111111111111");
const ACTOR = UserId("22222222-2222-7222-8222-222222222222");

function buildDeps() {
  let counter = 0;
  const now = () => new Date("2026-05-05T00:00:00Z");
  return {
    configs: new InMemorySlackBotConfigStore(),
    state: new InMemorySlackInstallStateStore(now),
    installs: new InMemorySlackInstallStore(),
    oauth: new FakeSlackOAuthClient(),
    manifest: new FakeSlackManifestBuilder(),
    randomState: () => `state-${++counter}`,
    now,
  };
}

describe("recordSlackInstall", () => {
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    deps = buildDeps();
  });

  it("consumes state, exchanges the code, and persists the install + app details", async () => {
    const created = await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage",
      actor: ACTOR,
    });
    deps.oauth.setNextResult({
      accessToken: "xoxb-test-token",
      appId: "A123",
      botUserId: "U123",
      teamId: "T_BLINK",
      teamName: "Acme HQ",
    });

    const result = await recordSlackInstall(deps, {
      state: created.state,
      code: "code-from-slack",
      redirectUri: "https://api.example.com/oauth/slack/callback",
    });

    expect(result.install.botConfigId).toBe(created.config.id);
    expect(result.install.slackTeamId as string).toBe("T_BLINK");
    expect(result.install.slackTeamName).toBe("Acme HQ");
    expect(result.install.botToken).toBe("xoxb-test-token");

    const config = await deps.configs.findById(created.config.id);
    expect(config?.slackAppId).toBe("A123");
    expect(config?.slackBotUserId).toBe("U123");

    expect(deps.oauth.calls).toHaveLength(1);
    expect(deps.oauth.calls[0]?.code).toBe("code-from-slack");
    expect(deps.oauth.calls[0]?.redirectUri).toBe(
      "https://api.example.com/oauth/slack/callback",
    );
  });

  it("rejects an unknown state token", async () => {
    deps.oauth.setNextResult({
      accessToken: "xoxb-test",
      appId: "A1",
      botUserId: "U1",
      teamId: "T1",
      teamName: "T1",
    });
    await expect(
      recordSlackInstall(deps, {
        state: "never-issued",
        code: "code",
        redirectUri: "https://api.example.com/oauth/slack/callback",
      }),
    ).rejects.toBeInstanceOf(SlackInstallAttemptInvalidError);
    // OAuth should never have been called when state was bad.
    expect(deps.oauth.calls).toHaveLength(0);
  });

  it("rejects a replayed state token", async () => {
    const created = await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage",
      actor: ACTOR,
    });
    deps.oauth.setNextResult({
      accessToken: "xoxb",
      appId: "A1",
      botUserId: "U1",
      teamId: "T1",
      teamName: "T1",
    });
    await recordSlackInstall(deps, {
      state: created.state,
      code: "code1",
      redirectUri: "https://api.example.com/oauth/slack/callback",
    });
    deps.oauth.setNextResult({
      accessToken: "xoxb2",
      appId: "A1",
      botUserId: "U1",
      teamId: "T1",
      teamName: "T1",
    });
    await expect(
      recordSlackInstall(deps, {
        state: created.state,
        code: "code2",
        redirectUri: "https://api.example.com/oauth/slack/callback",
      }),
    ).rejects.toBeInstanceOf(SlackInstallAttemptInvalidError);
  });

  it("upserts on re-install into the same team", async () => {
    const created = await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage",
      actor: ACTOR,
    });
    deps.oauth.setNextResult({
      accessToken: "xoxb-old",
      appId: "A1",
      botUserId: "U1",
      teamId: "T1",
      teamName: "Acme HQ",
    });
    await recordSlackInstall(deps, {
      state: created.state,
      code: "code1",
      redirectUri: "https://api.example.com/oauth/slack/callback",
    });

    const second = await createSlackBotConfig(deps, {
      workspaceId: WORKSPACE,
      rawBotName: "triage-2",
      actor: ACTOR,
    });
    // Same Slack team, different bot config — should produce a separate install.
    deps.oauth.setNextResult({
      accessToken: "xoxb-second",
      appId: "A2",
      botUserId: "U2",
      teamId: "T1",
      teamName: "Acme HQ",
    });
    const result2 = await recordSlackInstall(deps, {
      state: second.state,
      code: "code2",
      redirectUri: "https://api.example.com/oauth/slack/callback",
    });
    expect(deps.installs.rows.size).toBe(2);
    expect(result2.install.botToken).toBe("xoxb-second");
  });
});
