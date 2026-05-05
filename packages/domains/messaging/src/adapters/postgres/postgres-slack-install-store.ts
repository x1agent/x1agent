import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import {
  SlackInstallId,
  SlackTeamId,
  type SlackInstall,
} from "../../domain/slack-install.js";
import { SlackBotConfigId } from "../../domain/slack-bot-config.js";
import type { SlackInstallStore } from "../../ports/slack-install-store.js";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Token cipher seam. The store doesn't know AES details — it asks the
 * cipher to wrap on write, unwrap on read. The composition root wires
 * a real cipher backed by the workspace_secrets master key.
 */
export interface SlackTokenCipher {
  encrypt(plaintext: string): {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    authTag: Uint8Array;
  };
  decrypt(blob: {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    authTag: Uint8Array;
  }): string;
}

interface Row {
  id: string;
  bot_config_id: string;
  slack_team_id: string;
  slack_team_name: string | null;
  bot_token_ciphertext: Uint8Array;
  bot_token_nonce: Uint8Array;
  bot_token_auth_tag: Uint8Array;
  installed_by_user_id: string | null;
  installed_at: Date | string;
  revoked_at: Date | string | null;
}

const SELECT = `
  id, bot_config_id, slack_team_id, slack_team_name,
  bot_token_ciphertext, bot_token_nonce, bot_token_auth_tag,
  installed_by_user_id, installed_at, revoked_at
`;

export class PostgresSlackInstallStore implements SlackInstallStore {
  constructor(
    private readonly sql: Sql,
    private readonly cipher: SlackTokenCipher,
  ) {}

  private rowToInstall(r: Row): SlackInstall {
    const botToken = this.cipher.decrypt({
      ciphertext: new Uint8Array(r.bot_token_ciphertext),
      nonce: new Uint8Array(r.bot_token_nonce),
      authTag: new Uint8Array(r.bot_token_auth_tag),
    });
    return {
      id: SlackInstallId(r.id),
      botConfigId: SlackBotConfigId(r.bot_config_id),
      slackTeamId: SlackTeamId(r.slack_team_id),
      slackTeamName: r.slack_team_name,
      botToken,
      installedByUserId: r.installed_by_user_id
        ? UserId(r.installed_by_user_id)
        : null,
      installedAt: new Date(r.installed_at),
      revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
    };
  }

  async findById(id: SlackInstallId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_installs WHERE id = ${id}
    `;
    return rows[0] ? this.rowToInstall(rows[0]) : null;
  }

  async findByBotConfigAndTeam(botConfigId: SlackBotConfigId, teamId: SlackTeamId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_installs
      WHERE bot_config_id = ${botConfigId}
        AND slack_team_id = ${teamId as string}
        AND revoked_at IS NULL
    `;
    return rows[0] ? this.rowToInstall(rows[0]) : null;
  }

  async listByBotConfig(botConfigId: SlackBotConfigId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_installs
      WHERE bot_config_id = ${botConfigId} AND revoked_at IS NULL
      ORDER BY installed_at DESC
    `;
    return rows.map((r) => this.rowToInstall(r));
  }

  async findByAppAndTeam(slackAppId: string, teamId: SlackTeamId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(`i.${SELECT.split(",").map((c) => c.trim()).join(", i.")}`)}
      FROM slack_installs i
      JOIN slack_bot_configs c ON c.id = i.bot_config_id
      WHERE c.slack_app_id = ${slackAppId}
        AND i.slack_team_id = ${teamId as string}
        AND i.revoked_at IS NULL
    `;
    return rows[0] ? this.rowToInstall(rows[0]) : null;
  }

  async upsert(input: {
    botConfigId: SlackBotConfigId;
    slackTeamId: SlackTeamId;
    slackTeamName: string | null;
    botToken: string;
    installedByUserId: UserId | null;
  }) {
    const blob = this.cipher.encrypt(input.botToken);
    const rows = await this.sql<Row[]>`
      INSERT INTO slack_installs (
        bot_config_id, slack_team_id, slack_team_name,
        bot_token_ciphertext, bot_token_nonce, bot_token_auth_tag,
        installed_by_user_id, revoked_at
      )
      VALUES (
        ${input.botConfigId}, ${input.slackTeamId as string}, ${input.slackTeamName},
        ${Buffer.from(blob.ciphertext) as unknown as Uint8Array},
        ${Buffer.from(blob.nonce) as unknown as Uint8Array},
        ${Buffer.from(blob.authTag) as unknown as Uint8Array},
        ${input.installedByUserId}, NULL
      )
      ON CONFLICT (bot_config_id, slack_team_id) DO UPDATE SET
        slack_team_name = EXCLUDED.slack_team_name,
        bot_token_ciphertext = EXCLUDED.bot_token_ciphertext,
        bot_token_nonce = EXCLUDED.bot_token_nonce,
        bot_token_auth_tag = EXCLUDED.bot_token_auth_tag,
        installed_by_user_id = EXCLUDED.installed_by_user_id,
        installed_at = now(),
        revoked_at = NULL
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return this.rowToInstall(rows[0]!);
  }

  async markRevoked(id: SlackInstallId, at: Date) {
    await this.sql`
      UPDATE slack_installs SET revoked_at = ${at} WHERE id = ${id}
    `;
  }
}
