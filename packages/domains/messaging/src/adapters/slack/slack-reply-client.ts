/**
 * Minimal Slack chat.postMessage client used by the events handler to
 * send a reply with a per-bot bot token. Distinct from the
 * SlackMessagingProvider because it does NOT go through the messaging
 * port — the events flow already knows the install context (channel,
 * token) and just needs to post one message back.
 *
 * Lives here as a thin adapter rather than reusing the messaging
 * provider because the messaging provider's port wraps the bot token
 * at construction time. The events handler holds tokens per-event,
 * not per-process, so a function that accepts the token-per-call is
 * cleaner than spinning up a SlackMessagingProvider per event.
 *
 * Failure modes are surfaced with structured `kind` codes so the
 * caller (the events handler hooks) can decide whether to mark the
 * install revoked, back off and retry, or just log-and-move-on. Slack
 * itself documents these error strings in the chat.postMessage spec.
 */

export interface SlackReplyInput {
  botToken: string;
  channel: string;
  text: string;
  /** Reply in-thread when set; otherwise top-level channel post. */
  threadTs?: string | null;
}

export interface SlackReplyClient {
  postReply(input: SlackReplyInput): Promise<void>;
}

/**
 * Reasons a postReply call can fail. Hooks consume this to decide
 * what side effect (if any) to take beyond logging.
 *
 *   - `revoked`: token_revoked / account_inactive / invalid_auth /
 *     not_authed / token_expired. The install is permanently broken
 *     until the user reinstalls; the install row should be marked
 *     revoked so we stop posting to it.
 *   - `rate_limited`: Slack's `ratelimited` (or 429). Retry-After
 *     header is preserved on the error if Slack provided one.
 *   - `channel_unavailable`: channel_not_found, not_in_channel,
 *     is_archived, restricted_action. Bot was removed from the
 *     channel, or never invited. Channel-registry should be
 *     updated; we don't try to repost.
 *   - `transient`: network error, timeout, 5xx HTTP, anything else
 *     not enumerated. Caller may retry; we don't on the post-reply
 *     hot path because Slack would already retry the inbound event
 *     if we delay too long.
 */
export type SlackReplyFailureKind =
  | "revoked"
  | "rate_limited"
  | "channel_unavailable"
  | "transient";

export class SlackReplyError extends Error {
  constructor(
    public readonly kind: SlackReplyFailureKind,
    public readonly slackErrorCode: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`slack chat.postMessage failed (${kind}): ${slackErrorCode}`);
  }
}

export interface SlackHttpReplyClientConfig {
  fetchFn?: typeof fetch;
  /** Total timeout for the chat.postMessage call. Slack normally
   *  responds in <500ms; longer than this and Slack would already
   *  have retried the inbound event we're replying to. */
  timeoutMs?: number;
}

const REVOKED_CODES = new Set([
  "token_revoked",
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
]);

const CHANNEL_UNAVAILABLE_CODES = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
]);

export class SlackHttpReplyClient implements SlackReplyClient {
  constructor(private readonly cfg: SlackHttpReplyClientConfig = {}) {}

  async postReply(input: SlackReplyInput): Promise<void> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const timeoutMs = this.cfg.timeoutMs ?? 5_000;

    let res: Response;
    try {
      res = await fetchFn("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: input.channel,
          text: input.text,
          thread_ts: input.threadTs ?? undefined,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const code = (err as Error)?.name === "TimeoutError" ? "timeout" : "network_error";
      throw new SlackReplyError("transient", code);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0) || undefined;
      throw new SlackReplyError("rate_limited", "ratelimited", retryAfter);
    }
    if (!res.ok) {
      throw new SlackReplyError("transient", `http_${res.status}`);
    }

    let json: { ok?: boolean; error?: string };
    try {
      json = (await res.json()) as { ok?: boolean; error?: string };
    } catch {
      throw new SlackReplyError("transient", "invalid_response_body");
    }

    if (json.ok) return;

    const code = json.error ?? "unknown";
    if (REVOKED_CODES.has(code)) {
      throw new SlackReplyError("revoked", code);
    }
    if (code === "ratelimited") {
      throw new SlackReplyError("rate_limited", code);
    }
    if (CHANNEL_UNAVAILABLE_CODES.has(code)) {
      throw new SlackReplyError("channel_unavailable", code);
    }
    throw new SlackReplyError("transient", code);
  }
}
