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
 * State consume strategy: state is consumed AT THE END, after the
 * install completes. If OAuth or DB writes fail mid-flight, the state
 * stays valid and the user can retry by reloading the callback URL
 * (Slack will issue a fresh OAuth code on the next "Install to
 * Workspace" click). This avoids the failure mode where a transient
 * Slack 5xx burns the state token and strands the user.
 *
 * Replay safety: the postgres state-store implements `consume` as an
 * atomic UPDATE...RETURNING. Two concurrent callbacks racing on the
 * same state token: only the first call's UPDATE matches a row; the
 * second gets null and rejects. Slack's OAuth code is also single-use
 * — Slack rejects code reuse — so a replay attacker who somehow got
 * past state would still get rejected at `oauth.v2.access`. Two layers.
 *
 * Atomicity guarantee: bot-config and install rows land in one DB
 * transaction inside `completer.completeInstall`. A mid-flight failure
 * rolls both back. State.consume runs only after that transaction
 * commits.
 */
export async function recordSlackInstall(
  deps: RecordSlackInstallDeps,
  input: RecordSlackInstallInput,
): Promise<RecordSlackInstallResult> {
  // Peek the state record without consuming. The actual consume runs
  // at the end, after every other operation succeeds.
  const peeked = await deps.state.peek(input.state);
  if (!peeked)
    throw new SlackInstallAttemptInvalidError("missing, expired, or replayed");

  const config = await deps.configs.findById(peeked.botConfigId);
  if (!config) throw new SlackBotConfigNotFoundError(peeked.botConfigId);

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
    installedByUserId: peeked.initiatingUserId,
  });

  // Only after the OAuth exchange + DB writes succeed do we consume
  // the state. A failed call earlier in the flow leaves the state
  // valid for retry. consume() returns null if a concurrent caller
  // already won the race; we don't error on that — the install is
  // already persisted and idempotent on (bot_config_id, team_id).
  await deps.state.consume(input.state);

  return { install, returnTo: peeked.returnTo };
}
