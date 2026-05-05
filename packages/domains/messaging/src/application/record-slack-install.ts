import type { SlackBotConfigStore } from "../ports/slack-bot-config-store.js";
import type { SlackInstallStateStore } from "../ports/slack-install-state-store.js";
import type { SlackInstallCompleter } from "../ports/slack-install-completer.js";
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
  /**
   * Single-write boundary that wraps both the bot-config app-id stamp
   * and the install upsert in one DB transaction. See the port for
   * the corruption mode this prevents.
   */
  completer: SlackInstallCompleter;
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
 * install row + bot-config app id atomically.
 *
 * Errors:
 *   - `SlackInstallAttemptInvalidError` for missing/expired/replayed state
 *   - `SlackBotConfigNotFoundError` if the state pointed at a config
 *     that has since been deleted
 *   - `SlackOAuthExchangeError` (from the OAuth client) if Slack rejects
 *     the code
 *
 * Atomicity guarantee: bot-config and install rows land in one DB
 * transaction. A mid-flight failure rolls both back, so a retry from
 * a fresh state token finds the same starting state. (The OAuth code
 * itself is single-use Slack-side, so the user has to re-initiate
 * from x1agent — but they can.)
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

  const install = await deps.completer.completeInstall({
    botConfigId: config.id,
    slackAppId: exchange.appId,
    slackBotUserId: exchange.botUserId,
    slackTeamId: SlackTeamId(exchange.teamId),
    slackTeamName: exchange.teamName,
    botToken: exchange.accessToken,
    installedByUserId: consumed.initiatingUserId,
  });

  return { install, returnTo: consumed.returnTo };
}
