import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import type { SlackInstallCompleter } from "../../ports/slack-install-completer.js";
import {
  SlackInstallId,
  SlackTeamId,
  type SlackInstall,
} from "../../domain/slack-install.js";
import { SlackBotConfigId } from "../../domain/slack-bot-config.js";
import type { SlackTokenCipher } from "./postgres-slack-install-store.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface InstallRow {
  id: string;
  bot_config_id: string;
  slack_team_id: string;
  slack_team_name: string | null;
  installed_by_user_id: string | null;
  installed_at: Date | string;
  revoked_at: Date | string | null;
}

/**
 * Atomic completer. Wraps two writes against two tables in a single
 * `sql.begin()` block so a mid-flight failure can't leave the system
 * in a half-installed state (see the port for the full rationale).
 *
 * `slack_app_id` is stamped on `slack_bot_configs` only on first
 * install (`WHERE slack_app_id IS NULL`) — subsequent installs into
 * other Slack workspaces share the same Slack app id and re-stamping
 * is a no-op.
 */
export class PostgresSlackInstallCompleter implements SlackInstallCompleter {
  constructor(
    private readonly sql: Sql,
    private readonly cipher: SlackTokenCipher,
  ) {}

  async completeInstall(input: {
    botConfigId: SlackBotConfigId;
    slackAppId: string;
    slackBotUserId: string;
    slackTeamId: SlackTeamId;
    slackTeamName: string | null;
    botToken: string;
    installedByUserId: UserId | null;
  }): Promise<SlackInstall> {
    const blob = this.cipher.encrypt(input.botToken);
    return this.sql.begin(async (tx) => {
      // First-install stamp on the bot config row. The WHERE clause
      // makes this idempotent across re-installs — only the first
      // hit writes the app id.
      await tx`
        UPDATE slack_bot_configs
        SET slack_app_id = ${input.slackAppId},
            slack_bot_user_id = ${input.slackBotUserId},
            updated_at = now()
        WHERE id = ${input.botConfigId}
          AND slack_app_id IS NULL
      `;

      // Install upsert: per (bot_config_id, slack_team_id). Re-installs
      // refresh token + team name and clear revoked_at.
      const rows = await tx<InstallRow[]>`
        INSERT INTO slack_installs (
          bot_config_id, slack_team_id, slack_team_name,
          bot_token_ciphertext, bot_token_nonce, bot_token_auth_tag,
          installed_by_user_id, revoked_at
        )
        VALUES (
          ${input.botConfigId},
          ${input.slackTeamId as string},
          ${input.slackTeamName},
          ${Buffer.from(blob.ciphertext) as unknown as Uint8Array},
          ${Buffer.from(blob.nonce) as unknown as Uint8Array},
          ${Buffer.from(blob.authTag) as unknown as Uint8Array},
          ${input.installedByUserId},
          NULL
        )
        ON CONFLICT (bot_config_id, slack_team_id) DO UPDATE SET
          slack_team_name = EXCLUDED.slack_team_name,
          bot_token_ciphertext = EXCLUDED.bot_token_ciphertext,
          bot_token_nonce = EXCLUDED.bot_token_nonce,
          bot_token_auth_tag = EXCLUDED.bot_token_auth_tag,
          installed_by_user_id = EXCLUDED.installed_by_user_id,
          installed_at = now(),
          revoked_at = NULL
        RETURNING
          id, bot_config_id, slack_team_id, slack_team_name,
          installed_by_user_id, installed_at, revoked_at
      `;

      const row = rows[0]!;
      return {
        id: SlackInstallId(row.id),
        botConfigId: SlackBotConfigId(row.bot_config_id),
        slackTeamId: SlackTeamId(row.slack_team_id),
        slackTeamName: row.slack_team_name,
        // The token never round-trips back through the completer — the
        // caller already has it from the OAuth exchange, and this hot
        // path doesn't need to redecrypt to return.
        botToken: input.botToken,
        installedByUserId: row.installed_by_user_id
          ? UserId(row.installed_by_user_id)
          : null,
        installedAt: new Date(row.installed_at),
        revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      };
    }) as Promise<SlackInstall>;
  }
}
