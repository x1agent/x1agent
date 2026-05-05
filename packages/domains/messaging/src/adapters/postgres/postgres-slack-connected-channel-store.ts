import type postgres from "postgres";
import type {
  SlackConnectedChannel,
  SlackConnectedChannelStore,
} from "../../ports/slack-connected-channel-store.js";
import { SlackInstallId } from "../../domain/slack-install.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  install_id: string;
  channel_id: string;
  channel_name: string | null;
  ambient: boolean;
  registered_at: Date | string;
  removed_at: Date | string | null;
}

function rowToChannel(r: Row): SlackConnectedChannel {
  return {
    id: r.id,
    installId: SlackInstallId(r.install_id),
    channelId: r.channel_id,
    channelName: r.channel_name,
    ambient: r.ambient,
    registeredAt: new Date(r.registered_at),
    removedAt: r.removed_at ? new Date(r.removed_at) : null,
  };
}

const SELECT = `
  id, install_id, channel_id, channel_name, ambient,
  registered_at, removed_at
`;

export class PostgresSlackConnectedChannelStore
  implements SlackConnectedChannelStore
{
  constructor(private readonly sql: Sql) {}

  async register(input: {
    installId: SlackInstallId;
    channelId: string;
    channelName?: string | null;
  }) {
    const rows = await this.sql<Row[]>`
      INSERT INTO slack_connected_channels
        (install_id, channel_id, channel_name)
      VALUES (${input.installId}, ${input.channelId}, ${input.channelName ?? null})
      ON CONFLICT (install_id, channel_id) DO UPDATE SET
        channel_name = COALESCE(EXCLUDED.channel_name, slack_connected_channels.channel_name),
        removed_at = NULL
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return rowToChannel(rows[0]!);
  }

  async markRemoved(installId: SlackInstallId, channelId: string) {
    await this.sql`
      UPDATE slack_connected_channels
      SET removed_at = now()
      WHERE install_id = ${installId} AND channel_id = ${channelId}
    `;
  }

  async listByInstall(installId: SlackInstallId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM slack_connected_channels
      WHERE install_id = ${installId} AND removed_at IS NULL
      ORDER BY registered_at DESC
    `;
    return rows.map(rowToChannel);
  }
}
