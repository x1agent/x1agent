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

export interface SlackHttpReplyClientConfig {
  fetchFn?: typeof fetch;
}

export class SlackHttpReplyClient implements SlackReplyClient {
  constructor(private readonly cfg: SlackHttpReplyClientConfig = {}) {}

  async postReply(input: SlackReplyInput): Promise<void> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const res = await fetchFn("https://slack.com/api/chat.postMessage", {
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
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!json.ok) {
      throw new Error(`slack chat.postMessage failed: ${json.error}`);
    }
  }
}
