import type postgres from "postgres";
import { WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import type { Workspace } from "../../domain/workspace.js";
import type { WorkspaceRepository } from "../../ports/workspace-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  slug: string;
  name: string;
  created_at: Date | string;
}

function toWorkspace(r: Row): Workspace {
  return {
    id: WorkspaceId(r.id),
    slug: WorkspaceSlug(r.slug),
    name: r.name,
    createdAt: new Date(r.created_at),
  };
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly sql: Sql) {}

  async findById(id: WorkspaceId) {
    const rows = await this.sql<Row[]>`
      SELECT id, slug, name, created_at FROM workspaces WHERE id = ${id}
    `;
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  async findBySlug(slug: WorkspaceSlug) {
    const rows = await this.sql<Row[]>`
      SELECT id, slug, name, created_at FROM workspaces WHERE slug = ${slug}
    `;
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  async create(input: { slug: WorkspaceSlug; name: string }) {
    const rows = await this.sql<Row[]>`
      INSERT INTO workspaces (slug, name) VALUES (${input.slug}, ${input.name})
      RETURNING id, slug, name, created_at
    `;
    return toWorkspace(rows[0]!);
  }
}
