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

  async updateSettings(
    id: WorkspaceId,
    patch: Partial<WorkspaceSettings>,
  ) {
    // Read-merge-write so the merge happens in TypeScript and the
    // patch lands in postgres as a single, fully-formed jsonb object.
    //
    // The previous `settings || ${JSON.stringify(patch)}::jsonb`
    // approach ran afoul of postgres-js's parameter encoding: the
    // stringified JSON came through the wire as a JSON *string* (not
    // an object), so the `||` operator concatenated into a jsonb
    // ARRAY instead of merging. Resulting rows looked like
    // `[{}, "{...}", "{...}"]` and the parser fell back to defaults
    // on read — i.e. user clicks Save, UI shows "Saved", then snaps
    // back to the default.
    //
    // Two round-trips here is fine; this method is admin-only and
    // runs at human-toggle frequency. Atomic write of the post-merge
    // object also avoids the subtlety of having two callers race
    // through partial merges on different keys.
    const current = await this.findById(id);
    if (!current) return null;
    const merged: WorkspaceSettings = { ...current.settings, ...patch };
    const rows = await this.sql<Row[]>`
      UPDATE workspaces
      SET settings = ${this.sql.json(
        merged as unknown as Parameters<typeof this.sql.json>[0],
      )}
      WHERE id = ${id}
      RETURNING id, slug, name, created_at, settings
    `;
    return rows[0] ? toWorkspace(rows[0]) : null;
  }
}
