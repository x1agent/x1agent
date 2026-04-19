import { describe, expect, it } from "bun:test";
import { DomainError } from "@x1agent/kernel";
import {
  ChannelId,
  ChannelNotFoundError,
  MessagingUnauthorizedError,
} from "../domain/message.js";
import type { MessagingProvider } from "../ports/messaging-provider.js";

export interface MessagingProviderContractFixture {
  name: string;
  /** Build a happy-path provider whose postMessage succeeds. */
  happyFactory: () => MessagingProvider;
  /**
   * Build a provider that always rejects with MessagingUnauthorizedError.
   * Skipped when the adapter cannot fake auth failure.
   */
  unauthorizedFactory?: () => MessagingProvider;
  /**
   * Build a provider seeded to treat `unknownChannel` as missing.
   * Adapter should throw ChannelNotFoundError. Skipped when absent.
   */
  channelNotFoundFactory?: () => MessagingProvider;
  /** A channel id the happy-path provider accepts. */
  validChannel: string;
  /** A channel id the channelNotFoundFactory rejects. */
  unknownChannel?: string;
}

/**
 * Runs the conformance suite for a MessagingProvider adapter. Adapters
 * call this from their own test file; behaviour is identical regardless
 * of backend. Any adapter that passes this suite can be dropped into
 * the provider service without further work.
 */
export function runMessagingProviderContract(
  fx: MessagingProviderContractFixture,
): void {
  describe(`MessagingProvider contract — ${fx.name}`, () => {
    it("postMessage returns a PostedMessage whose channel echoes the input", async () => {
      const p = fx.happyFactory();
      const out = await p.postMessage({
        channel: ChannelId(fx.validChannel),
        options: { text: "hello from contract test" },
      });
      expect(out.channel).toBe(ChannelId(fx.validChannel));
      expect(out.providerMessageId.length).toBeGreaterThan(0);
      expect(out.postedAt instanceof Date).toBe(true);
    });

    it("postMessage preserves thread + username options", async () => {
      const p = fx.happyFactory();
      await p.postMessage({
        channel: ChannelId(fx.validChannel),
        options: {
          text: "threaded",
          threadId: "thread-42",
          username: "x1agent",
        },
      });
      // No return shape for options — adapters are free to store or
      // ignore them. The contract is just "does not throw".
    });

    if (fx.unauthorizedFactory) {
      it("throws MessagingUnauthorizedError when provider rejects auth", async () => {
        const p = fx.unauthorizedFactory!();
        try {
          await p.postMessage({
            channel: ChannelId(fx.validChannel),
            options: { text: "no auth" },
          });
          throw new Error("expected MessagingUnauthorizedError");
        } catch (err) {
          expect(err).toBeInstanceOf(MessagingUnauthorizedError);
          expect((err as DomainError).code).toBe("messaging_unauthorized");
        }
      });
    }

    if (fx.channelNotFoundFactory && fx.unknownChannel) {
      it("throws ChannelNotFoundError for an unknown channel", async () => {
        const p = fx.channelNotFoundFactory!();
        try {
          await p.postMessage({
            channel: ChannelId(fx.unknownChannel!),
            options: { text: "no channel" },
          });
          throw new Error("expected ChannelNotFoundError");
        } catch (err) {
          expect(err).toBeInstanceOf(ChannelNotFoundError);
          expect((err as DomainError).code).toBe("channel_not_found");
        }
      });
    }
  });
}
