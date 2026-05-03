import type postgres from "postgres";
import type { CatalogEntry } from "../../domain/catalog-entry.js";
import { CatalogName } from "../../domain/catalog-name.js";
import type { Manifest } from "../../domain/manifest.js";
import type {
  CatalogRepository,
  CatalogUpsertInput,
} from "../../ports/catalog-repository.js";

interface CatalogRow {
  id: string;
  workspace_id: string;
  name: string;
  display_name: string | null;
  image: string | null;
  command: string | null;
  args: string[];
  manifest: Manifest;
  description: string;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function rowToEntry(row: CatalogRow): CatalogEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: CatalogName(row.name),
    displayName: row.display_name,
    image: row.image,
    command: row.command,
    args: Array.isArray(row.args) ? row.args : [],
    manifest: row.manifest,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

export class PostgresCatalogRepository implements CatalogRepository {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async list(workspaceId: string): Promise<CatalogEntry[]> {
    const rows = await this.sql<CatalogRow[]>`
      SELECT id, workspace_id, name, display_name, image, command, args,
             manifest, description, created_at, updated_at, created_by
      FROM mcp_catalog_entries
      WHERE workspace_id = ${workspaceId}
      ORDER BY name ASC
    `;
    return rows.map(rowToEntry);
  }

  async getById(
    workspaceId: string,
    id: string,
  ): Promise<CatalogEntry | null> {
    const [row] = await this.sql<CatalogRow[]>`
      SELECT id, workspace_id, name, display_name, image, command, args,
             manifest, description, created_at, updated_at, created_by
      FROM mcp_catalog_entries
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `;
    return row ? rowToEntry(row) : null;
  }

  async getByName(
    workspaceId: string,
    name: CatalogName,
  ): Promise<CatalogEntry | null> {
    const [row] = await this.sql<CatalogRow[]>`
      SELECT id, workspace_id, name, display_name, image, command, args,
             manifest, description, created_at, updated_at, created_by
      FROM mcp_catalog_entries
      WHERE workspace_id = ${workspaceId} AND name = ${name as string}
    `;
    return row ? rowToEntry(row) : null;
  }

  async upsert(input: CatalogUpsertInput): Promise<CatalogEntry> {
    const [row] = await this.sql<CatalogRow[]>`
      INSERT INTO mcp_catalog_entries
        (workspace_id, name, display_name, image, command, args,
         manifest, description, created_by)
      VALUES (
        ${input.workspaceId},
        ${input.name as string},
        ${input.displayName},
        ${input.image},
        ${input.command},
        ${this.sql.json(input.args as never)},
        ${this.sql.json(input.manifest as never)},
        ${input.description},
        ${input.createdBy}
      )
      ON CONFLICT (workspace_id, name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        image = EXCLUDED.image,
        command = EXCLUDED.command,
        args = EXCLUDED.args,
        manifest = EXCLUDED.manifest,
        description = EXCLUDED.description,
        updated_at = now()
      RETURNING id, workspace_id, name, display_name, image, command, args,
                manifest, description, created_at, updated_at, created_by
    `;
    if (!row) throw new Error("mcp_catalog_entries upsert returned no row");
    return rowToEntry(row);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM mcp_catalog_entries
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `;
    return (result.count ?? 0) > 0;
  }
}
