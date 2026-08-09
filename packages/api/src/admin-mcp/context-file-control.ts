import type postgres from "postgres";
import { Buffer } from "node:buffer";

type Sql = postgres.Sql<Record<string, unknown>>;

interface ContextFileRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  path: string;
  mime_type: string;
  content: string;
  size_bytes: number;
  revision: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const ALLOWED_MIME = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/yaml",
  "text/csv",
]);

function normalizedPath(path: string): string {
  const value = path.trim();
  if (
    !value ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => !segment || segment === ".." || segment === ".")
  ) {
    throw Object.assign(new Error("path must be a normalized relative path"), {
      code: "validation_error",
      details: { field: "path" },
    });
  }
  return value;
}

function serialize(row: ContextFileRow, includeContent: boolean) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    path: row.path,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    revision: row.revision,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    ...(includeContent ? { content: row.content } : {}),
  };
}

export class AdminMcpContextFileControl {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, agentId: string) {
    const rows = await this.sql<ContextFileRow[]>`
      SELECT id, workspace_id, agent_id, path, mime_type, content,
             size_bytes, revision, created_by, created_at, updated_at
      FROM agent_context_files
      WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
      ORDER BY path ASC
    `;
    return rows.map((row) => serialize(row, false));
  }

  async get(workspaceId: string, agentId: string, path: string) {
    const safePath = normalizedPath(path);
    const rows = await this.sql<ContextFileRow[]>`
      SELECT id, workspace_id, agent_id, path, mime_type, content,
             size_bytes, revision, created_by, created_at, updated_at
      FROM agent_context_files
      WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
        AND path = ${safePath}
      LIMIT 1
    `;
    return rows[0] ? serialize(rows[0], true) : null;
  }

  async put(input: {
    workspaceId: string;
    agentId: string;
    actorUserId: string;
    path: string;
    mimeType: string;
    content: string;
    expectedRevision?: number | null;
  }) {
    const path = normalizedPath(input.path);
    if (!ALLOWED_MIME.has(input.mimeType)) {
      throw Object.assign(new Error("unsupported context file mime_type"), {
        code: "validation_error",
        details: { field: "mime_type", allowed: [...ALLOWED_MIME] },
      });
    }
    const size = Buffer.byteLength(input.content, "utf8");
    if (size > 262_144) {
      throw Object.assign(new Error("context file exceeds 256 KiB"), {
        code: "validation_error",
        details: { field: "content", size_bytes: size },
      });
    }
    return this.sql.begin(async (tx) => {
      const totals = await tx<{ total: number }[]>`
        SELECT COALESCE(sum(size_bytes), 0)::int AS total
        FROM agent_context_files
        WHERE workspace_id = ${input.workspaceId} AND agent_id = ${input.agentId}
          AND path <> ${path}
      `;
      if ((totals[0]?.total ?? 0) + size > 1_048_576) {
        throw Object.assign(new Error("agent context files exceed 1 MiB total"), {
          code: "validation_error",
          details: { field: "content", max_agent_bytes: 1_048_576 },
        });
      }
      let rows: ContextFileRow[];
      if (input.expectedRevision === null || input.expectedRevision === undefined) {
        rows = await tx<ContextFileRow[]>`
          INSERT INTO agent_context_files (
            workspace_id, agent_id, path, mime_type, content,
            size_bytes, created_by
          ) VALUES (
            ${input.workspaceId}, ${input.agentId}, ${path}, ${input.mimeType},
            ${input.content}, ${size}, ${input.actorUserId}
          )
          ON CONFLICT (agent_id, path) DO NOTHING
          RETURNING id, workspace_id, agent_id, path, mime_type, content,
                    size_bytes, revision, created_by, created_at, updated_at
        `;
      } else {
        rows = await tx<ContextFileRow[]>`
          UPDATE agent_context_files
          SET mime_type = ${input.mimeType}, content = ${input.content},
              size_bytes = ${size}, revision = revision + 1,
              updated_at = now()
          WHERE workspace_id = ${input.workspaceId}
            AND agent_id = ${input.agentId} AND path = ${path}
            AND revision = ${input.expectedRevision}
          RETURNING id, workspace_id, agent_id, path, mime_type, content,
                    size_bytes, revision, created_by, created_at, updated_at
        `;
      }
      if (!rows[0]) {
        const current = await tx<{ revision: number }[]>`
          SELECT revision FROM agent_context_files
          WHERE workspace_id = ${input.workspaceId}
            AND agent_id = ${input.agentId} AND path = ${path}
        `;
        throw Object.assign(new Error("context file revision conflict"), {
          code: "revision_conflict",
          details: { current_revision: current[0]?.revision ?? null },
        });
      }
      return serialize(rows[0], true);
    });
  }

  async delete(workspaceId: string, agentId: string, path: string) {
    const safePath = normalizedPath(path);
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM agent_context_files
      WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
        AND path = ${safePath}
      RETURNING id
    `;
    return rows.length > 0;
  }
}
