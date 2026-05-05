/**
 * Adapter port for Slack's OAuth v2 endpoints. The real implementation
 * calls `https://slack.com/api/oauth.v2.access`; tests inject a fake.
 *
 * Kept narrow on purpose — this port is just the OAuth code exchange.
 * Posting messages, listing channels, etc. live behind separate ports
 * so adapters can be assembled independently.
 */
export interface SlackOAuthClient {
  exchangeCodeForToken(input: {
    code: string;
    redirectUri: string;
  }): Promise<SlackOAuthExchangeResult>;
}

export interface SlackOAuthExchangeResult {
  accessToken: string;
  appId: string;
  botUserId: string;
  teamId: string;
  teamName: string | null;
}

export class SlackOAuthExchangeError extends Error {
  constructor(public readonly slackErrorCode: string) {
    super(`slack oauth exchange failed: ${slackErrorCode}`);
  }
}
