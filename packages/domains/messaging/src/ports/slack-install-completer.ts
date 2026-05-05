import type { UserId } from "@x1agent/kernel";
import type { SlackBotConfigId } from "../domain/slack-bot-config.js";
import type { SlackInstall, SlackTeamId } from "../domain/slack-install.js";

/**
 * Atomic OAuth-install completion. Wraps the two writes that follow a
 * successful `oauth.v2.access`:
 *
 *   1. UPDATE slack_bot_configs SET slack_app_id = ?, slack_bot_user_id = ?
 *      WHERE id = ? AND slack_app_id IS NULL  -- idempotent first-install stamp
 *   2. INSERT INTO slack_installs (...) ON CONFLICT (...) DO UPDATE SET ...
 *
 * They MUST land in a single DB transaction. Without it, a partial
 * failure between #1 and #2 leaves the system in a corrupt state:
 *   - state token consumed (Slack OAuth code is single-use, Slack will
 *     reject re-exchange)
 *   - bot_config has slack_app_id set
 *   - no install row exists
 *
 * On the next attempt, `record-slack-install` skips the
 * `if (!config.slackAppId)` branch (the app id is already there from
 * the prior partial), but the user can't actually generate a fresh
 * OAuth code because the bot config thinks it's done.
 *
 * The port hides the SQL transaction boundary; the postgres adapter
 * runs the two writes inside `sql.begin()`. The fake calls both
 * underlying stores inline (no transaction needed).
 */
export interface SlackInstallCompleter {
  completeInstall(input: {
    botConfigId: SlackBotConfigId;
    slackAppId: string;
    slackBotUserId: string;
    slackTeamId: SlackTeamId;
    slackTeamName: string | null;
    botToken: string;
    installedByUserId: UserId | null;
  }): Promise<SlackInstall>;
}
