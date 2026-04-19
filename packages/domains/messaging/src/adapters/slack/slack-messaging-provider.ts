import { WebClient, ErrorCode } from "@slack/web-api";
import {
  ChannelId,
  ChannelNotFoundError,
  MessagingProviderUnreachableError,
  MessagingUnauthorizedError,
  type PostedMessage,
} from "../../domain/message.js";
import type {
  MessagingProvider,
  PostMessageInput,
} from "../../ports/messaging-provider.js";

export interface SlackMessagingProviderConfig {
  /**
   * Bot user OAuth token (starts with `xoxb-`). Phase 1 reads this from
   * an environment variable on the provider deployment; Phase 2 will
   * swap to per-workspace OAuth installations + credential proxy.
   */
  botToken: string;
  /** Injected in tests. */
  client?: WebClient;
}

interface SlackLikeChatResponse {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  permalink?: string;
  message?: { permalink?: string };
}

/**
 * Slack adapter for the MessagingProvider port. The adapter itself is
 * a plain class — the provider service (packages/providers/messaging-slack)
 * wraps it in a NATS subscriber. That separation keeps unit tests
 * fast: adapter tests stub the WebClient, service tests wire NATS.
 */
export class SlackMessagingProvider implements MessagingProvider {
  readonly id = "slack";
  private readonly client: WebClient;

  constructor(cfg: SlackMessagingProviderConfig) {
    this.client =
      cfg.client ??
      new WebClient(cfg.botToken, {
        retryConfig: { retries: 0 },
      });
  }

  async postMessage(input: PostMessageInput): Promise<PostedMessage> {
    let res: SlackLikeChatResponse;
    try {
      res = (await this.client.chat.postMessage({
        channel: input.channel,
        text: input.options.text,
        thread_ts: input.options.threadId,
        username: input.options.username,
      })) as SlackLikeChatResponse;
    } catch (err) {
      throw translateSlackError(err);
    }

    if (!res.ok || !res.ts || !res.channel) {
      throw translateSlackApiFailure(res.error ?? "unknown_error");
    }

    // chat.postMessage doesn't include a permalink; the caller can
    // derive one from ts + channel if it wants, but we keep `url: null`
    // to avoid a second API call on the hot path.
    return {
      providerMessageId: res.ts,
      channel: ChannelId(res.channel),
      postedAt: new Date(Number(res.ts.split(".")[0]) * 1000),
      url: null,
    };
  }
}

function translateSlackApiFailure(code: string): Error {
  if (code === "channel_not_found" || code === "not_in_channel")
    return new ChannelNotFoundError(code);
  if (
    code === "invalid_auth" ||
    code === "not_authed" ||
    code === "token_revoked" ||
    code === "token_expired"
  )
    return new MessagingUnauthorizedError("slack", code);
  return new MessagingProviderUnreachableError("slack", code);
}

function translateSlackError(err: unknown): Error {
  const e = err as { code?: string; data?: { error?: string }; message?: string };
  if (e?.code === ErrorCode.PlatformError && e.data?.error) {
    return translateSlackApiFailure(e.data.error);
  }
  if (e?.code === ErrorCode.RequestError || e?.code === ErrorCode.HTTPError)
    return new MessagingProviderUnreachableError(
      "slack",
      e.message ?? String(e.code),
    );
  return new MessagingProviderUnreachableError(
    "slack",
    (err as Error)?.message ?? String(err),
  );
}
