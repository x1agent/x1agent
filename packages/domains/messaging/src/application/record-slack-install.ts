import type { SlackBotConfigStore } from "../ports/slack-bot-config-store.js";
import type { SlackInstallStateStore } from "../ports/slack-install-state-store.js";
import type { SlackInstallStore } from "../ports/slack-install-store.js";
import type { SlackOAuthClient } from "../ports/slack-oauth-client.js";
import {
  SlackInstallAttemptInvalidError,
  type SlackInstall,
  SlackTeamId,
} from "../domain/slack-install.js";
import { SlackBotConfigNotFoundError } from "../domain/slack-bot-config.js";

export interface RecordSlackInstallDeps {
  oauth: SlackOAuthClient;
  configs: SlackBotConfigStore;
  installs: SlackInstallStore;
  state: SlackInstallStateStore;
}

export interface RecordSlackInstallInput {
  state: string;
  code: string;
  redirectUri: string;
}

export interface RecordSlackInstallResult {
  install: SlackInstall;
  returnTo: string | null;
}

/**
 * Called from the OAuth callback. Consumes the state token, exchanges
 * the code for a bot token via `oauth.v2.access`, and persists the
 * install row.
 *
 * Errors:
 *   - `SlackInstallAttemptInvalidError` for missing/expired/replayed state
 *   - `SlackBotConfigNotFoundError` if the state pointed at a config
 *     that has since been deleted
 *   - `SlackOAuthExchangeError` (from the OAuth client) if Slack rejects
 *     the code
 */
export async function recordSlackInstall(
  deps: RecordSlackInstallDeps,
  input: RecordSlackInstallInput,
): Promise<RecordSlackInstallResult> {
  const consumed = await deps.state.consume(input.state);
  if (!consumed)
    throw new SlackInstallAttemptInvalidError("missing, expired, or replayed");

  const config = await deps.configs.findById(consumed.botConfigId);
  if (!config) throw new SlackBotConfigNotFoundError(consumed.botConfigId);

  const exchange = await deps.oauth.exchangeCodeForToken({
    code: input.code,
    redirectUri: input.redirectUri,
  });

  // Record the Slack-side identifiers on the bot config the first time
  // we see them. Subsequent installs into other Slack teams reuse the
  // same app id — Slack guarantees one app id per app, so this is a
  // no-op after the first install.
  if (!config.slackAppId) {
    await deps.configs.recordSlackAppDetails({
      id: config.id,
      slackAppId: exchange.appId,
      slackBotUserId: exchange.botUserId,
    });
  }

  const install = await deps.installs.upsert({
    botConfigId: config.id,
    slackTeamId: SlackTeamId(exchange.teamId),
    slackTeamName: exchange.teamName,
    botToken: exchange.accessToken,
    installedByUserId: consumed.initiatingUserId,
  });

  return { install, returnTo: consumed.returnTo };
}
