import type postgres from "postgres";
import type { AgentImage } from "../../domain/agent-image.js";
import type { DockerfileSource } from "../../domain/dockerfile-source.js";
import { ImageName } from "../../domain/image-name.js";
import type { ImageStatus } from "../../domain/image-status.js";
import type {
  AgentImageRepository,
  CreateImageInput,
  UpdateImageInput,
} from "../../ports/agent-image-repository.js";

interface Row {
  id: string;
  workspace_id: string | null;
  name: string;
  display_name: string;
  description: string | null;
  built_ref: string;
  is_preset: boolean;
  dockerfile_source: string;
  build_status: string;
  build_log: string;
  last_built_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id, workspace_id, name, display_name, description, built_ref,
  is_preset, dockerfile_source, build_status, build_log, last_built_at,
  created_at, updated_at`;

function toEntity(row: Row): AgentImage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: ImageName(row.name),
    displayName: row.display_name,
    description: row.description,
    builtRef: row.built_ref,
    isPreset: row.is_preset,
    dockerfileSource: (row.dockerfile_source ?? "") as
      | DockerfileSource
      | "",
    buildStatus: (row.build_status as ImageStatus) ?? "ready",
    buildLog: row.build_log ?? "",
    lastBuiltAt: row.last_built_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresAgentImageRepository implements AgentImageRepository {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async list(workspaceId: string): Promise<AgentImage[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLS)}
      FROM agent_images
      WHERE workspace_id IS NULL OR workspace_id = ${workspaceId}
      ORDER BY is_preset DESC, name ASC
    `;
    return rows.map(toEntity);
  }

  async getVisible(
    workspaceId: string,
    id: string,
  ): Promise<AgentImage | null> {
    const [row] = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLS)}
      FROM agent_images
      WHERE id = ${id}
        AND (workspace_id IS NULL OR workspace_id = ${workspaceId})
    `;
    return row ? toEntity(row) : null;
  }

  async findByName(
    workspaceId: string,
    name: string,
  ): Promise<AgentImage | null> {
    const [row] = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLS)}
      FROM agent_images
      WHERE workspace_id = ${workspaceId} AND name = ${name as string}
    `;
    return row ? toEntity(row) : null;
  }

  async create(input: CreateImageInput): Promise<AgentImage> {
    const [row] = await this.sql<Row[]>`
      INSERT INTO agent_images
        (workspace_id, name, display_name, description, built_ref,
         is_preset, dockerfile_source, build_status, build_log)
      VALUES (
        ${input.workspaceId},
        ${input.name as unknown as string},
        ${input.displayName},
        ${input.description},
        ${input.builtRef},
        false,
        ${input.dockerfileSource as unknown as string},
        ${input.buildStatus},
        ''
      )
      RETURNING ${this.sql.unsafe(COLS)}
    `;
    if (!row) throw new Error("agent_images insert returned no row");
    return toEntity(row);
  }

  async update(input: UpdateImageInput): Promise<AgentImage | null> {
    // Build a single dynamic UPDATE. postgres.js's tagged template
    // doesn't support optional column lists naturally, so we use
    // sql.unsafe for the SET clause after building it from a whitelist.
    const sets: postgres.PendingQuery<Row[]>[] = [];
    if (input.displayName !== undefined) {
      sets.push(this.sql`display_name = ${input.displayName}`);
    }
    if (input.description !== undefined) {
      sets.push(this.sql`description = ${input.description}`);
    }
    if (input.dockerfileSource !== undefined) {
      sets.push(
        this.sql`dockerfile_source = ${input.dockerfileSource as unknown as string}`,
      );
    }
    if (input.buildStatus !== undefined) {
      sets.push(this.sql`build_status = ${input.buildStatus}`);
    }
    if (input.builtRef !== undefined) {
      sets.push(this.sql`built_ref = ${input.builtRef}`);
    }
    if (input.buildLog !== undefined) {
      sets.push(this.sql`build_log = ${input.buildLog}`);
    }
    if (input.lastBuiltAt !== undefined) {
      sets.push(this.sql`last_built_at = ${input.lastBuiltAt}`);
    }
    if (sets.length === 0) {
      // Nothing to update — just re-read.
      return this.getVisible(input.workspaceId, input.id);
    }
    sets.push(this.sql`updated_at = now()`);

    // postgres.js spreads array of fragments inside template via comma:
    // sql`${sql`a`, sql`b`}` doesn't work. Use sql.unsafe + parameter
    // collection by running a stored-procedure-style helper: build the
    // SET fragment by joining with a runtime helper.
    //
    // Simpler approach: just use postgres.js's `${sql(setObject)}` form
    // for column-update objects. That keeps us out of unsafe territory.
    const setObject: Record<string, unknown> = {};
    if (input.displayName !== undefined) setObject.display_name = input.displayName;
    if (input.description !== undefined) setObject.description = input.description;
    if (input.dockerfileSource !== undefined)
      setObject.dockerfile_source = input.dockerfileSource as unknown as string;
    if (input.buildStatus !== undefined) setObject.build_status = input.buildStatus;
    if (input.builtRef !== undefined) setObject.built_ref = input.builtRef;
    if (input.buildLog !== undefined) setObject.build_log = input.buildLog;
    if (input.lastBuiltAt !== undefined) setObject.last_built_at = input.lastBuiltAt;
    setObject.updated_at = this.sql`now()`;

    const [row] = await this.sql<Row[]>`
      UPDATE agent_images
      SET ${this.sql(setObject)}
      WHERE id = ${input.id}
        AND workspace_id = ${input.workspaceId}
        AND is_preset = false
      RETURNING ${this.sql.unsafe(COLS)}
    `;
    return row ? toEntity(row) : null;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM agent_images
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND is_preset = false
    `;
    return (result.count ?? 0) > 0;
  }
}
