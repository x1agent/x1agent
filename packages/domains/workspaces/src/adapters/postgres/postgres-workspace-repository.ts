import type postgres from "postgres";
import { WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import type { Workspace } from "../../domain/workspace.js";
import {
  parseWorkspaceSettings,
  type WorkspaceSettings,
} from "../../domain/workspace-settings.js";
import type { WorkspaceRepository } from "../../ports/workspace-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  slug: string;
  name: string;
  created_at: Date | string;
  settings: unknown;
}

function toWorkspace(r: Row): Workspace {
  return {
    id: WorkspaceId(r.id),
    slug: WorkspaceSlug(r.slug),
    name: r.name,
    createdAt: new Date(r.created_at),
    settings: parseWorkspaceSettings(r.settings),
  };
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly sql: Sql) {}

  async findById(id: WorkspaceId) {
    const rows = await this.sql<Row[]>`
      SELECT id, slug, name, created_at, settings
      FROM workspaces WHERE id = ${id}
    `;
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  async findBySlug(slug: WorkspaceSlug) {
    const rows = await this.sql<Row[]>`
      SELECT id, slug, name, created_at, settings
      FROM workspaces WHERE slug = ${slug}
    `;
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  async create(input: { slug: WorkspaceSlug; name: string }) {
    const rows = await this.sql<Row[]>`
      INSERT INTO workspaces (slug, name) VALUES (${input.slug}, ${input.name})
      RETURNING id, slug, name, created_at, settings
    `;
    return toWorkspace(rows[0]!);
  }

  async updateSettings(id: WorkspaceId, patch: Partial<WorkspaceSettings>) {
    // Merge the typed JSON object in one UPDATE. Using sql.json(patch), rather
    // than JSON.stringify(patch), preserves the jsonb object type and makes
    // concurrent patches to different keys atomic instead of last-write-wins.
    const rows = await this.sql<Row[]>`
      UPDATE workspaces
      SET settings = COALESCE(settings, '{}'::jsonb) || ${this.sql.json(
        patch as unknown as Parameters<typeof this.sql.json>[0],
      )}
      WHERE id = ${id}
      RETURNING id, slug, name, created_at, settings
    `;
    return rows[0] ? toWorkspace(rows[0]) : null;
  }
}
