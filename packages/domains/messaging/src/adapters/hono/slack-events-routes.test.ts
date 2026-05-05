import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { createSlackEventsRoutes } from "./slack-events-routes.js";
import {
  InMemorySlackBotConfigStore,
  InMemorySlackInstallStore,
} from "../../application/slack-fakes.js";
import { SlackBotName } from "../../domain/slack-bot-config.js";
import { SlackTeamId } from "../../domain/slack-install.js";

const WORKSPACE = WorkspaceId("11111111-1111-7111-8111-111111111111");
const ACTOR = UserId("22222222-2222-7222-8222-222222222222");
const APP_ID = "A0123ABC";
const TEAM_ID = "T_BLINK";
const SIGNING_SECRET = "test-signing-secret-32chars-long";
const BOT_TOKEN = "xoxb-test-token";
const BOT_USER_ID = "U_BOT";

function sign(timestamp: string, body: string, secret: string): string {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

async function buildHarness() {
  const configs = new InMemorySlackBotConfigStore();
  const installs = new InMemorySlackInstallStore();
  const created = await configs.create({
    workspaceId: WORKSPACE,
    botName: SlackBotName("triage"),
    createdBy: ACTOR,
  });
  await configs.recordSlackAppDetails({
    id: created.id,
    slackAppId: APP_ID,
    slackBotUserId: BOT_USER_ID,
  });
  await configs.recordSigningSecret({
    id: created.id,
    plaintext: SIGNING_SECRET,
  });
  await installs.upsert({
    botConfigId: created.id,
    slackTeamId: SlackTeamId(TEAM_ID),
    slackTeamName: "Acme HQ",
    botToken: BOT_TOKEN,
    installedByUserId: ACTOR,
  });
  // The fake findBySlackAppId iterates rows; the real postgres adapter
  // hits a unique index. The events handler calls findBySlackAppId, so
  // we ensure the fake's lookup works for the test scenario.
  const fixedNow = new Date("2026-05-05T00:00:00Z");
  return { configs, installs, fixedNow, botConfigId: created.id };
}

function buildApp(harness: Awaited<ReturnType<typeof buildHarness>>, hooks?: {
  onAppMention?: any;
  onDirectMessage?: any;
  onMemberJoinedChannel?: any;
  onMemberLeftChannel?: any;
}) {
  // The InMemorySlackInstallStore's findByAppAndTeam is intentionally a
  // stub (returns null) since real lookups happen via SQL join in the
  // postgres adapter. The events handler uses findByBotConfigAndTeam
  // after resolving the bot config, which the fake DOES implement.
  const events = createSlackEventsRoutes({
    configs: harness.configs,
    installs: harness.installs,
    now: () => harness.fixedNow,
    ...hooks,
  });
  const app = new Hono();
  app.route("/api/slack/events", events);
  return app;
}

async function postEvent(
  app: Hono,
  body: object,
  opts: { secret?: string; timestamp?: number; signature?: string } = {},
) {
  const raw = JSON.stringify(body);
  const ts = opts.timestamp ?? Math.floor(Date.parse("2026-05-05T00:00:00Z") / 1000);
  const sig = opts.signature ?? sign(String(ts), raw, opts.secret ?? SIGNING_SECRET);
  return app.request("/api/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": sig,
    },
    body: raw,
  });
}

describe("createSlackEventsRoutes", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("answers the url_verification challenge without checking the signature", async () => {
    const app = buildApp(harness);
    const res = await app.request("/api/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "url_verification",
        challenge: "abc123",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string };
    expect(json.challenge).toBe("abc123");
  });

  it("rejects an event with no signature headers", async () => {
    const app = buildApp(harness);
    const res = await app.request("/api/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "event_callback",
        api_app_id: APP_ID,
        team_id: TEAM_ID,
        event: { type: "app_mention" },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    const app = buildApp(harness);
    const ts = Math.floor(harness.fixedNow.getTime() / 1000);
    const original = JSON.stringify({
      type: "event_callback",
      api_app_id: APP_ID,
      team_id: TEAM_ID,
      event: { type: "app_mention", channel: "C1", user: "U1", text: "hi", ts: "1.0" },
    });
    const sig = sign(String(ts), original, SIGNING_SECRET);
    const tampered = original.replace("hi", "DROP TABLE users");
    const res = await app.request("/api/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(ts),
        "x-slack-signature": sig,
      },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it("forwards a valid app_mention to the hook with full context", async () => {
    const calls: any[] = [];
    const app = buildApp(harness, {
      onAppMention: async (ctx: any) => calls.push(ctx),
    });
    const res = await postEvent(app, {
      type: "event_callback",
      api_app_id: APP_ID,
      team_id: TEAM_ID,
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U_HUMAN",
        text: "<@U_BOT> what's up",
        ts: "1700000000.000100",
        thread_ts: "1700000000.000099",
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].channelId).toBe("C1");
    expect(calls[0].fromSlackUserId).toBe("U_HUMAN");
    expect(calls[0].userText).toBe("<@U_BOT> what's up");
    expect(calls[0].threadTs).toBe("1700000000.000099");
    expect(calls[0].botToken).toBe(BOT_TOKEN);
    expect(calls[0].slackTeamId).toBe(TEAM_ID);
  });

  it("forwards a DM (message.im) to the dm hook, not the mention hook", async () => {
    const mentions: any[] = [];
    const dms: any[] = [];
    const app = buildApp(harness, {
      onAppMention: async (c: any) => mentions.push(c),
      onDirectMessage: async (c: any) => dms.push(c),
    });
    const res = await postEvent(app, {
      type: "event_callback",
      api_app_id: APP_ID,
      team_id: TEAM_ID,
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U_HUMAN",
        text: "hey",
        ts: "1700000000.000200",
      },
    });
    expect(res.status).toBe(200);
    expect(mentions).toHaveLength(0);
    expect(dms).toHaveLength(1);
    expect(dms[0].userText).toBe("hey");
  });

  it("ignores a message.im whose author is the bot itself (no echo loop)", async () => {
    const dms: any[] = [];
    const app = buildApp(harness, {
      onDirectMessage: async (c: any) => dms.push(c),
    });
    const res = await postEvent(app, {
      type: "event_callback",
      api_app_id: APP_ID,
      team_id: TEAM_ID,
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: BOT_USER_ID,
        text: "I sent this",
        ts: "1700000000.000300",
      },
    });
    expect(res.status).toBe(200);
    expect(dms).toHaveLength(0);
  });

  it("only fires member_joined_channel when the bot itself joins", async () => {
    const joins: any[] = [];
    const app = buildApp(harness, {
      onMemberJoinedChannel: async (c: any) => joins.push(c),
    });
    // Someone else joining: hook should NOT fire.
    const r1 = await postEvent(app, {
      type: "event_callback",
      api_app_id: APP_ID,
      team_id: TEAM_ID,
      event: {
        type: "member_joined_channel",
        channel: "C1",
        user: "U_HUMAN",
      },
    });
    expect(r1.status).toBe(200);
    expect(joins).toHaveLength(0);
    // The bot itself joining: hook fires.
    const r2 = await postEvent(app, {
      type: "event_callback",
      api_app_id: APP_ID,
      team_id: TEAM_ID,
      event: {
        type: "member_joined_channel",
        channel: "C2",
        user: BOT_USER_ID,
      },
    });
    expect(r2.status).toBe(200);
    expect(joins).toHaveLength(1);
    expect(joins[0].channelId).toBe("C2");
  });

  it("returns 200 even when a hook throws (Slack would otherwise retry)", async () => {
    const app = buildApp(harness, {
      onAppMention: async () => {
        throw new Error("boom");
      },
    });
    const res = await postEvent(app, {
      type: "event_callback",
      api_app_id: APP_ID,
      team_id: TEAM_ID,
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U_HUMAN",
        text: "hi",
        ts: "1700000000.000400",
      },
    });
    expect(res.status).toBe(200);
  });
});
