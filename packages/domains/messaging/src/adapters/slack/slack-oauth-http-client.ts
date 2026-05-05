import {
  SlackOAuthExchangeError,
  type SlackOAuthClient,
  type SlackOAuthExchangeResult,
} from "../../ports/slack-oauth-client.js";

interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  access_token?: string;
  app_id?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
}

export interface SlackOAuthHttpClientConfig {
  clientId: string;
  clientSecret: string;
  /** Override for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Real `oauth.v2.access` client. Performs a form-encoded POST and
 * unwraps Slack's stable response shape. On `ok: false` or any
 * missing required field, throws `SlackOAuthExchangeError` with the
 * upstream error code so the route handler can surface it to the UI.
 *
 * Error handling rules of engagement:
 *   - Network failure → `SlackOAuthExchangeError("network_error")`.
 *   - Non-2xx HTTP response (Slack returning a 5xx HTML page during
 *     an outage, a proxy error, etc.) → `SlackOAuthExchangeError("http_<status>")`.
 *     Without this guard, `res.json()` on an HTML body would throw a
 *     SyntaxError that propagates as an uncaught 500 — the OAuth
 *     state token is already consumed at that point and the user is
 *     stranded with no path to retry.
 *   - 2xx but non-JSON body → `SlackOAuthExchangeError("invalid_response_body")`.
 *   - 10s timeout via AbortSignal — Slack normally answers in <500ms;
 *     anything past 10s is a hung connection we shouldn't wait on.
 */
export class SlackOAuthHttpClient implements SlackOAuthClient {
  constructor(private readonly cfg: SlackOAuthHttpClientConfig) {}

  async exchangeCodeForToken(input: {
    code: string;
    redirectUri: string;
  }): Promise<SlackOAuthExchangeResult> {
    const fetchFn = this.cfg.fetchFn ?? fetch;

    let res: Response;
    try {
      res = await fetchFn("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new SlackOAuthExchangeError(
        (err as Error)?.name === "TimeoutError" ? "timeout" : "network_error",
      );
    }

    if (!res.ok) {
      throw new SlackOAuthExchangeError(`http_${res.status}`);
    }

    let json: SlackOAuthV2Response;
    try {
      json = (await res.json()) as SlackOAuthV2Response;
    } catch {
      throw new SlackOAuthExchangeError("invalid_response_body");
    }

    if (!json.ok) throw new SlackOAuthExchangeError(json.error ?? "unknown");
    if (!json.access_token || !json.app_id || !json.bot_user_id || !json.team?.id)
      throw new SlackOAuthExchangeError("missing_fields");
    return {
      accessToken: json.access_token,
      appId: json.app_id,
      botUserId: json.bot_user_id,
      teamId: json.team.id,
      teamName: json.team.name ?? null,
    };
  }
}
