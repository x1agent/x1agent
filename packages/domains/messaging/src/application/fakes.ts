import {
  ChannelId,
  ChannelNotFoundError,
  MessagingUnauthorizedError,
  type PostedMessage,
} from "../domain/message.js";
import type {
  MessagingProvider,
  PostMessageInput,
} from "../ports/messaging-provider.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `fake-msg-${counter.toString().padStart(6, "0")}`;
}

interface FakeMessage {
  providerMessageId: string;
  channel: ChannelId;
  text: string;
  threadId: string | null;
  username: string | null;
  postedAt: Date;
}

export interface InMemoryMessagingProviderOptions {
  /**
   * Channels the fake accepts. Defaults to accepting anything — tests
   * that want "unknown channel" behaviour pass an explicit set.
   */
  allowChannels?: ReadonlySet<string>;
  /** Set to true to simulate an auth failure on every call. */
  unauthorized?: boolean;
}

/**
 * In-memory messaging provider for tests. Records every post to
 * `messages` so assertions can read it back. No side effects, no
 * network — safe to construct freely.
 */
export class InMemoryMessagingProvider implements MessagingProvider {
  readonly id = "fake";
  readonly messages: FakeMessage[] = [];

  constructor(private readonly opts: InMemoryMessagingProviderOptions = {}) {}

  async postMessage(input: PostMessageInput): Promise<PostedMessage> {
    if (this.opts.unauthorized) {
      throw new MessagingUnauthorizedError(this.id);
    }
    if (this.opts.allowChannels && !this.opts.allowChannels.has(input.channel))
      throw new ChannelNotFoundError(input.channel);

    const rec: FakeMessage = {
      providerMessageId: nextId(),
      channel: input.channel,
      text: input.options.text,
      threadId: input.options.threadId ?? null,
      username: input.options.username ?? null,
      postedAt: new Date(),
    };
    this.messages.push(rec);
    return {
      providerMessageId: rec.providerMessageId,
      channel: rec.channel,
      postedAt: rec.postedAt,
      url: null,
    };
  }
}
