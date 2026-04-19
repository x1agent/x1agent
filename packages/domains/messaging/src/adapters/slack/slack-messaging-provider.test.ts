import { describe, expect, it } from "bun:test";
import { ErrorCode, WebClient } from "@slack/web-api";
import { runMessagingProviderContract } from "../../contract-tests/messaging-provider.contract.js";
import { ChannelId } from "../../domain/message.js";
import { SlackMessagingProvider } from "./slack-messaging-provider.js";

/**
 * Build a SlackMessagingProvider whose underlying WebClient is
 * overridden with a hand-rolled chat.postMessage. The adapter never
 * reaches the network in tests.
 */
function makeProvider(
  postMessageImpl: (args: Record<string, unknown>) => Promise<unknown>,
): SlackMessagingProvider {
  const client = new WebClient("xoxb-not-real");
  (
    client as unknown as {
      chat: { postMessage: (a: Record<string, unknown>) => Promise<unknown> };
    }
  ).chat = {
    postMessage: postMessageImpl,
  };
  return new SlackMessagingProvider({ botToken: "xoxb-not-real", client });
}

const okResponse = (channel: string) => async () => ({
  ok: true,
  ts: "1714502400.000100",
  channel,
  message: { text: "hi" },
});

runMessagingProviderContract({
  name: "SlackMessagingProvider",
  happyFactory: () => makeProvider(okResponse("C0123456789")),
  unauthorizedFactory: () =>
    makeProvider(async () => {
      const err = Object.assign(new Error("invalid_auth"), {
        code: ErrorCode.PlatformError,
        data: { error: "invalid_auth" },
      });
      throw err;
    }),
  channelNotFoundFactory: () =>
    makeProvider(async () => {
      const err = Object.assign(new Error("channel_not_found"), {
        code: ErrorCode.PlatformError,
        data: { error: "channel_not_found" },
      });
      throw err;
    }),
  validChannel: "C0123456789",
  unknownChannel: "C9999999999",
});

describe("SlackMessagingProvider behaviour", () => {
  it("echoes the channel Slack returns (can differ from input for #name)", async () => {
    // Slack normalizes `#ops` to its channel id `C0001`. The adapter
    // must return the normalized id, not the caller's alias.
    const provider = makeProvider(async (args) => {
      expect(args["channel"]).toBe("#ops");
      return {
        ok: true,
        ts: "1714502400.000100",
        channel: "C0001",
      };
    });
    const out = await provider.postMessage({
      channel: ChannelId("#ops"),
      options: { text: "hi" },
    });
    expect(out.channel).toBe(ChannelId("C0001"));
  });

  it("passes threadId as thread_ts and username verbatim", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = makeProvider(async (args) => {
      captured = args;
      return { ok: true, ts: "1714502400.000200", channel: "C0002" };
    });
    await provider.postMessage({
      channel: ChannelId("C0002"),
      options: {
        text: "threaded",
        threadId: "1714502400.000100",
        username: "x1-ops",
      },
    });
    expect(captured!["thread_ts"]).toBe("1714502400.000100");
    expect(captured!["username"]).toBe("x1-ops");
  });

  it("maps Slack ts to a Date", async () => {
    const provider = makeProvider(async () => ({
      ok: true,
      ts: "1714502400.000100",
      channel: "C0003",
    }));
    const out = await provider.postMessage({
      channel: ChannelId("C0003"),
      options: { text: "ts check" },
    });
    // Slack's ts is "<unix_seconds>.<decimal>" — 1714502400 → 2024-04-30 18:40 UTC.
    expect(out.postedAt.toISOString()).toBe("2024-04-30T18:40:00.000Z");
  });

  it("translates RequestError to messaging_provider_unreachable", async () => {
    const provider = makeProvider(async () => {
      const err = Object.assign(new Error("network down"), {
        code: ErrorCode.RequestError,
      });
      throw err;
    });
    try {
      await provider.postMessage({
        channel: ChannelId("C0004"),
        options: { text: "boom" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(
        "messaging_provider_unreachable",
      );
    }
  });

  it("wraps a response with ok=false into the right domain error", async () => {
    const provider = makeProvider(async () => ({
      ok: false,
      error: "token_revoked",
    }));
    try {
      await provider.postMessage({
        channel: ChannelId("C0005"),
        options: { text: "x" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("messaging_unauthorized");
    }
  });
});
