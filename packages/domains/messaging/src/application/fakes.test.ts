import { describe, it, expect } from "bun:test";
import { DomainError } from "@x1agent/kernel";
import {
  ChannelId,
  ChannelNotFoundError,
  MessagingUnauthorizedError,
} from "../domain/message.js";
import { runMessagingProviderContract } from "../contract-tests/messaging-provider.contract.js";
import { InMemoryMessagingProvider } from "./fakes.js";

// The fake satisfies the same contract as every real adapter — this is
// the proof.
runMessagingProviderContract({
  name: "InMemoryMessagingProvider",
  happyFactory: () => new InMemoryMessagingProvider(),
  unauthorizedFactory: () =>
    new InMemoryMessagingProvider({ unauthorized: true }),
  channelNotFoundFactory: () =>
    new InMemoryMessagingProvider({ allowChannels: new Set(["#known"]) }),
  validChannel: "#ops",
  unknownChannel: "#does-not-exist",
});

describe("InMemoryMessagingProvider behaviour", () => {
  it("records every post", async () => {
    const p = new InMemoryMessagingProvider();
    await p.postMessage({
      channel: ChannelId("#one"),
      options: { text: "first" },
    });
    await p.postMessage({
      channel: ChannelId("#one"),
      options: { text: "second", threadId: "t1" },
    });
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0]!.text).toBe("first");
    expect(p.messages[1]!.threadId).toBe("t1");
  });

  it("produces monotonically unique ids", async () => {
    const p = new InMemoryMessagingProvider();
    const a = await p.postMessage({
      channel: ChannelId("#x"),
      options: { text: "a" },
    });
    const b = await p.postMessage({
      channel: ChannelId("#x"),
      options: { text: "b" },
    });
    expect(a.providerMessageId).not.toBe(b.providerMessageId);
  });

  it("rejects empty channel at ChannelId construction", () => {
    expect(() => ChannelId("")).toThrow(/channel must not be empty/);
  });

  it("unauthorized flavour throws the right code", async () => {
    const p = new InMemoryMessagingProvider({ unauthorized: true });
    try {
      await p.postMessage({
        channel: ChannelId("#any"),
        options: { text: "x" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MessagingUnauthorizedError);
      expect((err as DomainError).code).toBe("messaging_unauthorized");
    }
  });

  it("channel allowlist flavour throws channel_not_found", async () => {
    const p = new InMemoryMessagingProvider({
      allowChannels: new Set(["#known"]),
    });
    try {
      await p.postMessage({
        channel: ChannelId("#unknown"),
        options: { text: "x" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelNotFoundError);
      expect((err as DomainError).code).toBe("channel_not_found");
    }
  });
});
