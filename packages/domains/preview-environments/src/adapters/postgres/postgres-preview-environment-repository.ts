import type postgres from "postgres";
import { WorkspaceId } from "@x1agent/kernel";
import {
  PreviewEnvironmentId,
  PreviewSlug,
  isDeployStatus,
  type DeployStatus,
  type PreviewEnvironment,
} from "../../domain/preview-environment.js";
import { PreviewSlugTakenError } from "../../domain/errors.js";
import type {
  PreviewEnvironmentRepository,
  UpsertPreviewEnvironmentInput,
} from "../../ports/preview-environment-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  repo_full_name: string;
  branch: string;
  last_deploy_sha: string | null;
  last_deploy_url: string | null;
  last_deploy_image_ref: string | null;
  last_deploy_status: string;
  last_deploy_status_reason: string | null;
  last_deploy_at: Date | string | null;
  env_var_names: unknown;
  alias_hosts: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function toEnv(r: Row): PreviewEnvironment {
  const status: DeployStatus = isDeployStatus(r.last_deploy_status)
    ? r.last_deploy_status
    : "pending";
  return {
    id: PreviewEnvironmentId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    slug: PreviewSlug(r.slug),
    title: r.title,
    repoFullName: r.repo_full_name,
    branch: r.branch,
    lastDeploySha: r.last_deploy_sha,
    lastDeployUrl: r.last_deploy_url,
    lastDeployImageRef: r.last_deploy_image_ref,
    lastDeployStatus: status,
    lastDeployStatusReason: r.last_deploy_status_reason,
    lastDeployAt: r.last_deploy_at ? new Date(r.last_deploy_at) : null,
    envVarNames: parseStringArray(r.env_var_names),
    aliasHosts: parseStringArray(r.alias_hosts),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

const SELECT = `
  id, workspace_id, slug, title, repo_full_name, branch,
  last_deploy_sha, last_deploy_url, last_deploy_image_ref,
  last_deploy_status, last_deploy_status_reason, last_deploy_at,
  env_var_names, alias_hosts,
  created_at, updated_at
`;

export class PostgresPreviewEnvironmentRepository
  implements PreviewEnvironmentRepository
{
  constructor(private readonly sql: Sql) {}

  async upsert(
    input: UpsertPreviewEnvironmentInput,
  ): Promise<PreviewEnvironment> {
    const { workspaceId, slug, initialTitle, repoFullName, branch, deploy } =
      input;

    // ON CONFLICT (workspace_id, slug) DO UPDATE — refuse to clobber a
    // row whose existing repo_full_name doesn't match the incoming one.
    // Two repos in one workspace claiming the same slug is operator
    // error; we surface it as a domain error so the agent gets a clear
    // failure rather than a silent overwrite.
    const rows = await this.sql<Row[]>`
      INSERT INTO preview_environments (
        workspace_id, slug, title, repo_full_name, branch,
        last_deploy_sha, last_deploy_url, last_deploy_image_ref,
        last_deploy_status, last_deploy_status_reason, last_deploy_at
      ) VALUES (
        ${workspaceId}, ${slug}, ${initialTitle}, ${repoFullName}, ${branch},
        ${deploy.sha}, ${deploy.url}, ${deploy.imageRef},
        ${deploy.status}, ${deploy.statusReason}, ${deploy.at}
      )
      ON CONFLICT (workspace_id, slug) DO UPDATE SET
        branch                    = EXCLUDED.branch,
        last_deploy_sha           = EXCLUDED.last_deploy_sha,
        last_deploy_url           = EXCLUDED.last_deploy_url,
        last_deploy_image_ref     = EXCLUDED.last_deploy_image_ref,
        last_deploy_status        = EXCLUDED.last_deploy_status,
        last_deploy_status_reason = EXCLUDED.last_deploy_status_reason,
        last_deploy_at            = EXCLUDED.last_deploy_at
      WHERE preview_environments.repo_full_name = EXCLUDED.repo_full_name
      RETURNING ${this.sql.unsafe(SELECT)};
    `;

    if (rows.length === 0) {
      // The row exists but its repo_full_name didn't match — the WHERE
      // clause vetoed the UPDATE. Read the existing row so we can name
      // the offending repo in the error.
      const existing = await this.sql<{ repo_full_name: string }[]>`
        SELECT repo_full_name FROM preview_environments
        WHERE workspace_id = ${workspaceId} AND slug = ${slug}
        LIMIT 1;
      `;
      throw new PreviewSlugTakenError(
        workspaceId,
        slug,
        existing[0]?.repo_full_name ?? "<unknown>",
      );
    }

    return toEnv(rows[0]!);
  }

  async findById(
    id: PreviewEnvironmentId,
  ): Promise<PreviewEnvironment | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)}
      FROM preview_environments
      WHERE id = ${id}
      LIMIT 1;
    `;
    return rows.length > 0 ? toEnv(rows[0]!) : null;
  }

  async findBySlug(
    workspaceId: WorkspaceId,
    slug: PreviewSlug,
  ): Promise<PreviewEnvironment | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)}
      FROM preview_environments
      WHERE workspace_id = ${workspaceId} AND slug = ${slug}
      LIMIT 1;
    `;
    return rows.length > 0 ? toEnv(rows[0]!) : null;
  }

  async listForWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<PreviewEnvironment[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)}
      FROM preview_environments
      WHERE workspace_id = ${workspaceId}
      ORDER BY last_deploy_at DESC NULLS LAST, created_at DESC;
    `;
    return rows.map(toEnv);
  }

  async rename(
    id: PreviewEnvironmentId,
    workspaceId: WorkspaceId,
    title: string,
  ): Promise<PreviewEnvironment> {
    const rows = await this.sql<Row[]>`
      UPDATE preview_environments
      SET title = ${title}
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING ${this.sql.unsafe(SELECT)};
    `;
    if (rows.length === 0) {
      // Surface as NotFound — the caller's tenant scope didn't match;
      // we don't leak whether the id exists elsewhere.
      const { PreviewEnvironmentNotFoundError } = await import(
        "../../domain/errors.js"
      );
      throw new PreviewEnvironmentNotFoundError({ id });
    }
    return toEnv(rows[0]!);
  }

  async delete(
    id: PreviewEnvironmentId,
    workspaceId: WorkspaceId,
  ): Promise<void> {
    await this.sql`
      DELETE FROM preview_environments
      WHERE id = ${id} AND workspace_id = ${workspaceId};
    `;
  }

  async setEnvVarNames(
    id: PreviewEnvironmentId,
    workspaceId: WorkspaceId,
    envVarNames: readonly string[],
  ): Promise<PreviewEnvironment> {
    // De-dupe + preserve order; trim entries; drop empties.
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of envVarNames) {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (v === "" || seen.has(v)) continue;
      seen.add(v);
      list.push(v);
    }
    const rows = await this.sql<Row[]>`
      UPDATE preview_environments
      SET env_var_names = ${this.sql.json(list)}::jsonb
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING ${this.sql.unsafe(SELECT)};
    `;
    if (rows.length === 0) {
      const { PreviewEnvironmentNotFoundError } = await import(
        "../../domain/errors.js"
      );
      throw new PreviewEnvironmentNotFoundError({ id });
    }
    return toEnv(rows[0]!);
  }

  async setAliasHosts(
    id: PreviewEnvironmentId,
    workspaceId: WorkspaceId,
    aliasHosts: readonly string[],
  ): Promise<PreviewEnvironment> {
    // De-dupe + lowercase + trim. Validation is the application
    // layer's job; this writes what it's handed.
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of aliasHosts) {
      const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (v === "" || seen.has(v)) continue;
      seen.add(v);
      list.push(v);
    }
    const rows = await this.sql<Row[]>`
      UPDATE preview_environments
      SET alias_hosts = ${this.sql.json(list)}::jsonb
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING ${this.sql.unsafe(SELECT)};
    `;
    if (rows.length === 0) {
      const { PreviewEnvironmentNotFoundError } = await import(
        "../../domain/errors.js"
      );
      throw new PreviewEnvironmentNotFoundError({ id });
    }
    return toEnv(rows[0]!);
  }
}
