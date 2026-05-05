import type postgres from "postgres";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import {
  AgentId,
  SlackBotConfigId,
  SlackBotConfigNameTakenError,
  SlackBotConfigNotFoundError,
  SlackBotName,
  type SlackBotConfig,
} from "../../domain/slack-bot-config.js";
import type { SlackBotConfigStore } from "../../ports/slack-bot-config-store.js";
import type { SlackTokenCipher } from "./postgres-slack-install-store.js";

/** Postgres unique-violation error code. Surfaced to translate the
 *  unique index on (workspace_id, bot_name) into a typed domain
 *  error rather than a generic 500. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === PG_UNIQUE_VIOLATION;
}

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  bot_name: string;
  slack_app_id: string | null;
  slack_bot_user_id: string | null;
  has_signing_secret: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SigningSecretRow {
  signing_secret_ciphertext: Uint8Array;
  signing_secret_nonce: Uint8Array;
  signing_secret_auth_tag: Uint8Array;
}

function rowToConfig(r: Row): SlackBotConfig {
  return {
    id: SlackBotConfigId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    agentId: r.agent_id ? AgentId(r.agent_id) : null,
    botName: SlackBotName(r.bot_name),
    slackAppId: r.slack_app_id,
    slackBotUserId: r.slack_bot_user_id,
    hasSigningSecret: r.has_signing_secret,
    createdBy: r.created_by ? UserId(r.created_by) : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

// Computes has_signing_secret server-side so the row shape is stable
// across reads. The three encrypted columns are nullable; presence of
// all three means a secret is on file.
const SELECT = `
  id, workspace_id, agent_id, bot_name, slack_app_id, slack_bot_user_id,
  (signing_secret_ciphertext IS NOT NULL
    AND signing_secret_nonce IS NOT NULL
    AND signing_secret_auth_tag IS NOT NULL) as has_signing_secret,
  created_by, created_at, updated_at
`;

export class PostgresSlackBotConfigStore implements SlackBotConfigStore {
  constructor(
    private readonly sql: Sql,
    private readonly cipher: SlackTokenCipher,
  ) {}

  async findById(id: SlackBotConfigId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_bot_configs WHERE id = ${id}
    `;
    return rows[0] ? rowToConfig(rows[0]) : null;
  }

  async findByWorkspaceAndName(workspaceId: WorkspaceId, name: SlackBotName) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_bot_configs
      WHERE workspace_id = ${workspaceId} AND bot_name = ${name as string}
    `;
    return rows[0] ? rowToConfig(rows[0]) : null;
  }

  async findByAgent(agentId: AgentId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_bot_configs
      WHERE agent_id = ${agentId}
    `;
    return rows[0] ? rowToConfig(rows[0]) : null;
  }

  async findBySlackAppId(slackAppId: string) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_bot_configs
      WHERE slack_app_id = ${slackAppId}
    `;
    return rows[0] ? rowToConfig(rows[0]) : null;
  }

  async listByWorkspace(workspaceId: WorkspaceId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_bot_configs
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
    return rows.map(rowToConfig);
  }

  async create(input: {
    workspaceId: WorkspaceId;
    botName: SlackBotName;
    createdBy: UserId | null;
  }) {
    try {
      const rows = await this.sql<Row[]>`
        INSERT INTO slack_bot_configs (workspace_id, bot_name, created_by)
        VALUES (${input.workspaceId}, ${input.botName as string}, ${input.createdBy})
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      const row = rows[0];
      if (!row) throw new Error("insert returned no rows");
      return rowToConfig(row);
    } catch (err) {
      // 23505 means another concurrent insert (or a prior insert we
      // didn't see in the application-layer pre-check) won the race
      // for this (workspace_id, bot_name). Translate to the typed
      // domain error so the route returns 409 instead of 500.
      if (isUniqueViolation(err)) {
        throw new SlackBotConfigNameTakenError(input.botName as string);
      }
      throw err;
    }
  }

  async recordSlackAppDetails(input: {
    id: SlackBotConfigId;
    slackAppId: string;
    slackBotUserId: string;
  }) {
    const rows = await this.sql<Row[]>`
      UPDATE slack_bot_configs
      SET slack_app_id = ${input.slackAppId},
          slack_bot_user_id = ${input.slackBotUserId},
          updated_at = now()
      WHERE id = ${input.id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    if (!rows[0])
      throw new SlackBotConfigNotFoundError(input.id as string);
    return rowToConfig(rows[0]);
  }

  async pair(input: { id: SlackBotConfigId; agentId: AgentId }) {
    const rows = await this.sql<Row[]>`
      UPDATE slack_bot_configs
      SET agent_id = ${input.agentId}, updated_at = now()
      WHERE id = ${input.id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    if (!rows[0])
      throw new SlackBotConfigNotFoundError(input.id as string);
    return rowToConfig(rows[0]);
  }

  async unpair(id: SlackBotConfigId) {
    const rows = await this.sql<Row[]>`
      UPDATE slack_bot_configs
      SET agent_id = NULL, updated_at = now()
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    if (!rows[0]) throw new SlackBotConfigNotFoundError(id as string);
    return rowToConfig(rows[0]);
  }

  async recordSigningSecret(input: {
    id: SlackBotConfigId;
    plaintext: string;
  }) {
    const blob = this.cipher.encrypt(input.plaintext);
    const rows = await this.sql<Row[]>`
      UPDATE slack_bot_configs
      SET signing_secret_ciphertext = ${
        Buffer.from(blob.ciphertext) as unknown as Uint8Array
      },
          signing_secret_nonce = ${
            Buffer.from(blob.nonce) as unknown as Uint8Array
          },
          signing_secret_auth_tag = ${
            Buffer.from(blob.authTag) as unknown as Uint8Array
          },
          updated_at = now()
      WHERE id = ${input.id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    if (!rows[0])
      throw new SlackBotConfigNotFoundError(input.id as string);
    return rowToConfig(rows[0]);
  }

  async getSigningSecretByAppId(slackAppId: string) {
    const rows = await this.sql<SigningSecretRow[]>`
      SELECT signing_secret_ciphertext, signing_secret_nonce,
             signing_secret_auth_tag
      FROM slack_bot_configs
      WHERE slack_app_id = ${slackAppId}
        AND signing_secret_ciphertext IS NOT NULL
        AND signing_secret_nonce IS NOT NULL
        AND signing_secret_auth_tag IS NOT NULL
    `;
    const row = rows[0];
    if (!row) return null;
    return this.cipher.decrypt({
      ciphertext: new Uint8Array(row.signing_secret_ciphertext),
      nonce: new Uint8Array(row.signing_secret_nonce),
      authTag: new Uint8Array(row.signing_secret_auth_tag),
    });
  }

  async delete(id: SlackBotConfigId) {
    await this.sql`DELETE FROM slack_bot_configs WHERE id = ${id}`;
  }
}
