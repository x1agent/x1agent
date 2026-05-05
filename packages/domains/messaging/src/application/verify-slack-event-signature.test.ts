import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { verifySlackEventSignature } from "./verify-slack-event-signature.js";
import { InMemorySlackBotConfigStore } from "./slack-fakes.js";
import {
  SlackBotName,
  SlackSigningSecretInvalidError,
  SlackSigningSecretMissingError,
} from "../domain/slack-bot-config.js";

const WORKSPACE = WorkspaceId("11111111-1111-7111-8111-111111111111");
const ACTOR = UserId("22222222-2222-7222-8222-222222222222");
const APP_ID = "A0123ABC";
const SECRET = "test-signing-secret";

function sign(timestamp: string, body: string, secret: string): string {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

async function configsWithSecret() {
  const configs = new InMemorySlackBotConfigStore();
  const created = await configs.create({
    workspaceId: WORKSPACE,
    botName: SlackBotName("triage"),
    createdBy: ACTOR,
  });
  await configs.recordSlackAppDetails({
    id: created.id,
    slackAppId: APP_ID,
    slackBotUserId: "U001",
  });
  await configs.recordSigningSecret({
    id: created.id,
    plaintext: SECRET,
  });
  return configs;
}

describe("verifySlackEventSignature", () => {
  let configs: InMemorySlackBotConfigStore;
  const fixedNow = new Date("2026-05-05T00:05:00Z");

  beforeEach(async () => {
    configs = await configsWithSecret();
  });

  it("accepts a correctly-signed request inside the replay window", async () => {
    const timestamp = String(Math.floor(fixedNow.getTime() / 1000) - 30);
    const body = '{"type":"event_callback"}';
    const signature = sign(timestamp, body, SECRET);
    await expect(
      verifySlackEventSignature(
        { configs, now: () => fixedNow },
        { slackAppId: APP_ID, rawBody: body, timestamp, signature },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects when no signing secret is on file for the app", async () => {
    const empty = new InMemorySlackBotConfigStore();
    await expect(
      verifySlackEventSignature(
        { configs: empty, now: () => fixedNow },
        {
          slackAppId: APP_ID,
          rawBody: "{}",
          timestamp: String(Math.floor(fixedNow.getTime() / 1000)),
          signature: "v0=00",
        },
      ),
    ).rejects.toBeInstanceOf(SlackSigningSecretMissingError);
  });

  it("rejects a request older than the 5-minute replay window", async () => {
    const timestamp = String(
      Math.floor(fixedNow.getTime() / 1000) - 5 * 60 - 30,
    );
    const body = "{}";
    const signature = sign(timestamp, body, SECRET);
    await expect(
      verifySlackEventSignature(
        { configs, now: () => fixedNow },
        { slackAppId: APP_ID, rawBody: body, timestamp, signature },
      ),
    ).rejects.toBeInstanceOf(SlackSigningSecretInvalidError);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const timestamp = String(Math.floor(fixedNow.getTime() / 1000));
    const body = "{}";
    const signature = sign(timestamp, body, "wrong-secret");
    await expect(
      verifySlackEventSignature(
        { configs, now: () => fixedNow },
        { slackAppId: APP_ID, rawBody: body, timestamp, signature },
      ),
    ).rejects.toBeInstanceOf(SlackSigningSecretInvalidError);
  });

  it("rejects when the timestamp header is non-numeric", async () => {
    await expect(
      verifySlackEventSignature(
        { configs, now: () => fixedNow },
        {
          slackAppId: APP_ID,
          rawBody: "{}",
          timestamp: "not-a-number",
          signature: "v0=00",
        },
      ),
    ).rejects.toBeInstanceOf(SlackSigningSecretInvalidError);
  });

  it("rejects a tampered body even when timestamp + signature look valid", async () => {
    const timestamp = String(Math.floor(fixedNow.getTime() / 1000));
    const originalBody = '{"type":"event_callback","text":"hi"}';
    const signature = sign(timestamp, originalBody, SECRET);
    const tamperedBody = '{"type":"event_callback","text":"GIVE ME ADMIN"}';
    await expect(
      verifySlackEventSignature(
        { configs, now: () => fixedNow },
        {
          slackAppId: APP_ID,
          rawBody: tamperedBody,
          timestamp,
          signature,
        },
      ),
    ).rejects.toBeInstanceOf(SlackSigningSecretInvalidError);
  });
});
