import type {
  ChannelId,
  PostMessageOptions,
  PostedMessage,
} from "../domain/message.js";

export interface PostMessageInput {
  channel: ChannelId;
  options: PostMessageOptions;
}

/**
 * The single port every messaging adapter implements. Slack, Teams,
 * Discord, a local-dev fake — they all satisfy this interface and
 * the contract test suite that exercises it.
 *
 * Phase 1 surface is deliberately tiny: one method, enough to send a
 * message. list_channels / read_history / edit / react are additive
 * and land as follow-up ports.
 */
export interface MessagingProvider {
  /** Identifier used in logs and the Helm `providers.messaging.type`. */
  readonly id: string;

  /**
   * Send a message. Must throw `ChannelNotFoundError` on unknown
   * channel, `MessagingUnauthorizedError` on auth failure,
   * `MessagingProviderUnreachableError` on network failure. Any other
   * throw is treated as a generic provider error by callers.
   */
  postMessage(input: PostMessageInput): Promise<PostedMessage>;
}
