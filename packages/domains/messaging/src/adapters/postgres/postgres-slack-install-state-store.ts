import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import { SlackBotConfigId } from "../../domain/slack-bot-config.js";
import type { SlackInstallStateStore } from "../../ports/slack-install-state-store.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  state_token: string;
  bot_config_id: string;
  initiating_user_id: string;
  return_to: string | null;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

/**
 * Postgres-backed single-use state store for Slack install OAuth.
 * Mirrors the GitHub flow: insert on /install/begin, atomically
 * consume on /install/callback. Expired or already-consumed rows
 * return null on consume so the route handler treats them all as one
 * "bad state" failure (this is intentional — see the port doc).
 */
export class PostgresSlackInstallStateStore implements SlackInstallStateStore {
  constructor(private readonly sql: Sql) {}

  async put(input: {
    state: string;
    botConfigId: SlackBotConfigId;
    initiatingUserId: UserId;
    expiresAt: Date;
    returnTo?: string | null;
  }) {
    await this.sql`
      INSERT INTO slack_install_attempts
        (state_token, bot_config_id, initiating_user_id, return_to, expires_at)
      VALUES (
        ${input.state}, ${input.botConfigId}, ${input.initiatingUserId},
        ${input.returnTo ?? null}, ${input.expiresAt}
      )
    `;
  }

  async consume(state: string) {
    // UPDATE … RETURNING with the freshness predicate inside the
    // WHERE clause makes consume atomic — a concurrent caller can't
    // race a same-state token through twice.
    const rows = await this.sql<Row[]>`
      UPDATE slack_install_attempts
      SET consumed_at = now()
      WHERE state_token = ${state}
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING state_token, bot_config_id, initiating_user_id,
                return_to, expires_at, consumed_at
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      botConfigId: SlackBotConfigId(row.bot_config_id),
      initiatingUserId: UserId(row.initiating_user_id),
      returnTo: row.return_to,
    };
  }
}
