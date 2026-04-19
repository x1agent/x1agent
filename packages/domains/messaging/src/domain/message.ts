import { DomainError, ValidationError } from "@x1agent/kernel";

/**
 * Provider-scoped channel identifier. Slack uses `C01234` IDs plus
 * human-readable names; Teams uses tuple IDs; Discord uses snowflakes.
 * The port stores whatever the adapter hands back verbatim — the agent
 * quotes the string the user gave it (e.g. "#ops", "@alice", a raw id)
 * and leaves normalization to the adapter.
 */
declare const channelIdBrand: unique symbol;
export type ChannelId = string & { readonly [channelIdBrand]: true };
export const ChannelId = (raw: string): ChannelId => {
  if (raw.trim().length === 0)
    throw new ValidationError("channel", "channel must not be empty");
  return raw as ChannelId;
};

/**
 * What the adapter returns after a successful postMessage. The UI card
 * and the audit log render `url` when present. `providerMessageId` is
 * the adapter's own id for the message — Slack's `ts`, Teams' message
 * id — so the agent can reference it later (edit, react, quote).
 */
export interface PostedMessage {
  providerMessageId: string;
  channel: ChannelId;
  postedAt: Date;
  url: string | null;
}

/** Agent-supplied options for a single post. Optional on the wire. */
export interface PostMessageOptions {
  /** Plain-text fallback used when the provider can't render rich blocks. */
  text: string;
  /** Thread id to reply into (Slack `thread_ts`, Teams replyToId). */
  threadId?: string;
  /** Bot display name override where the provider supports it. */
  username?: string;
}

export class ChannelNotFoundError extends DomainError {
  readonly code = "channel_not_found";
  constructor(public readonly channel: string) {
    super(`channel ${channel} was not found`);
  }
}

export class MessagingUnauthorizedError extends DomainError {
  readonly code = "messaging_unauthorized";
  constructor(public readonly provider: string, message?: string) {
    super(message ?? `${provider} rejected the request`);
  }
}

export class MessagingProviderUnreachableError extends DomainError {
  readonly code = "messaging_provider_unreachable";
  constructor(public readonly provider: string, public readonly cause: string) {
    super(`${provider} provider unreachable: ${cause}`);
  }
}
