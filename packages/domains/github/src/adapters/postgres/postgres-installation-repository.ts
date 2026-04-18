import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import type { InstallationRepository } from "../../ports/installation-repository.js";
import {
  InstallationId,
  type Installation,
} from "../../domain/installation.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  installation_id: string | number;
  account_login: string;
  account_type: string;
  installed_by_user_id: string;
  repository_selection: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

function toInstallation(r: Row): Installation {
  return {
    id: r.id,
    installationId: InstallationId(Number(r.installation_id)),
    accountLogin: r.account_login,
    accountType: r.account_type === "Organization" ? "Organization" : "User",
    installedByUserId: UserId(r.installed_by_user_id),
    repositorySelection: r.repository_selection === "all" ? "all" : "selected",
    createdAt: new Date(r.created_at),
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
  };
}

const SELECT = `
  id, installation_id, account_login, account_type,
  installed_by_user_id, repository_selection, created_at, revoked_at
`;

export class PostgresInstallationRepository implements InstallationRepository {
  constructor(private readonly sql: Sql) {}

  async findByInstallationId(id: InstallationId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM github_installations
      WHERE installation_id = ${id}
    `;
    return rows[0] ? toInstallation(rows[0]) : null;
  }

  async listByUser(userId: UserId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM github_installations
      WHERE installed_by_user_id = ${userId} AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;
    return rows.map(toInstallation);
  }

  async upsert(input: {
    installationId: InstallationId;
    accountLogin: string;
    accountType: "User" | "Organization";
    installedByUserId: UserId;
    repositorySelection: "all" | "selected";
  }) {
    const rows = await this.sql<Row[]>`
      INSERT INTO github_installations
        (installation_id, account_login, account_type,
         installed_by_user_id, repository_selection)
      VALUES (${input.installationId}, ${input.accountLogin},
              ${input.accountType}, ${input.installedByUserId},
              ${input.repositorySelection})
      ON CONFLICT (installation_id) DO UPDATE SET
        account_login = EXCLUDED.account_login,
        account_type = EXCLUDED.account_type,
        installed_by_user_id = EXCLUDED.installed_by_user_id,
        repository_selection = EXCLUDED.repository_selection,
        revoked_at = NULL
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toInstallation(rows[0]!);
  }

  async markRevoked(id: InstallationId, at: Date) {
    await this.sql`
      UPDATE github_installations SET revoked_at = ${at}
      WHERE installation_id = ${id}
    `;
  }
}
