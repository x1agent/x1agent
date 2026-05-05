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
 */
export class SlackOAuthHttpClient implements SlackOAuthClient {
  constructor(private readonly cfg: SlackOAuthHttpClientConfig) {}

  async exchangeCodeForToken(input: {
    code: string;
    redirectUri: string;
  }): Promise<SlackOAuthExchangeResult> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const res = await fetchFn("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }).toString(),
    });
    const json = (await res.json()) as SlackOAuthV2Response;
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
