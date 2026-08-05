import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { OAuthPrincipal } from "./oauth-store.js";

type Sql = postgres.Sql<Record<string, unknown>>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function adminMcpRequestHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export type IdempotencyClaim =
  | { kind: "acquired" }
  | { kind: "replay"; result: Record<string, unknown> }
  | { kind: "conflict" }
  | { kind: "in_progress" };

export interface AdminMcpOperationStore {
  claim(input: {
    principal: OAuthPrincipal;
    toolName: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<IdempotencyClaim>;
  complete(input: {
    principal: OAuthPrincipal;
    toolName: string;
    idempotencyKey: string;
    resourceId?: string;
    result: Record<string, unknown>;
  }): Promise<void>;
  fail(input: {
    principal: OAuthPrincipal;
    toolName: string;
    idempotencyKey: string;
  }): Promise<void>;
  audit(input: {
    principal: OAuthPrincipal;
    workspaceId?: string | null;
    toolName: string;
    resourceType?: string;
    resourceId?: string;
    outcome: "success" | "error";
    errorCode?: string;
    requestId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

interface IdempotencyRow {
  request_hash: string;
  state: "in_progress" | "completed" | "failed";
  sanitized_result: Record<string, unknown> | null;
  updated_at: Date;
}

const ABANDONED_OPERATION_MS = 15 * 60 * 1000;

export class PostgresAdminMcpOperationStore implements AdminMcpOperationStore {
  constructor(private readonly sql: Sql) {}

  async claim(input: {
    principal: OAuthPrincipal;
    toolName: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<IdempotencyClaim> {
    const inserted = await this.sql`
      INSERT INTO admin_mcp_idempotency (
        actor_user_id, oauth_client_id, tool_name, idempotency_key, request_hash
      ) VALUES (
        ${input.principal.userId}, ${input.principal.clientId}, ${input.toolName},
        ${input.idempotencyKey}, ${input.requestHash}
      )
      ON CONFLICT DO NOTHING
      RETURNING request_hash
    `;
    if (inserted.length > 0) return { kind: "acquired" };
    const rows = await this.sql<IdempotencyRow[]>`
      SELECT request_hash, state, sanitized_result, updated_at
      FROM admin_mcp_idempotency
      WHERE actor_user_id = ${input.principal.userId}
        AND oauth_client_id = ${input.principal.clientId}
        AND tool_name = ${input.toolName}
        AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.request_hash !== input.requestHash) return { kind: "conflict" };
    if (row.state === "completed" && row.sanitized_result) {
      return { kind: "replay", result: row.sanitized_result };
    }
    const abandoned =
      row.state === "in_progress" &&
      row.updated_at.getTime() < Date.now() - ABANDONED_OPERATION_MS;
    if (row.state === "failed" || abandoned) {
      const reclaimed = await this.sql`
        UPDATE admin_mcp_idempotency
        SET state = 'in_progress', updated_at = now()
        WHERE actor_user_id = ${input.principal.userId}
          AND oauth_client_id = ${input.principal.clientId}
          AND tool_name = ${input.toolName}
          AND idempotency_key = ${input.idempotencyKey}
          AND (
            state = 'failed'
            OR (state = 'in_progress' AND updated_at < now() - interval '15 minutes')
          )
        RETURNING tool_name
      `;
      if (reclaimed.length > 0) return { kind: "acquired" };
    }
    return { kind: "in_progress" };
  }

  async complete(input: {
    principal: OAuthPrincipal;
    toolName: string;
    idempotencyKey: string;
    resourceId?: string;
    result: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`
      UPDATE admin_mcp_idempotency
      SET state = 'completed', resource_id = ${input.resourceId ?? null},
          sanitized_result = ${this.sql.json(input.result as never)}, updated_at = now()
      WHERE actor_user_id = ${input.principal.userId}
        AND oauth_client_id = ${input.principal.clientId}
        AND tool_name = ${input.toolName}
        AND idempotency_key = ${input.idempotencyKey}
    `;
  }

  async fail(input: {
    principal: OAuthPrincipal;
    toolName: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.sql`
      UPDATE admin_mcp_idempotency SET state = 'failed', updated_at = now()
      WHERE actor_user_id = ${input.principal.userId}
        AND oauth_client_id = ${input.principal.clientId}
        AND tool_name = ${input.toolName}
        AND idempotency_key = ${input.idempotencyKey}
    `;
  }

  async audit(input: {
    principal: OAuthPrincipal;
    workspaceId?: string | null;
    toolName: string;
    resourceType?: string;
    resourceId?: string;
    outcome: "success" | "error";
    errorCode?: string;
    requestId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`
      INSERT INTO admin_audit_events (
        actor_user_id, workspace_id, oauth_client_id, tool_name,
        resource_type, resource_id, outcome, error_code, request_id,
        idempotency_key, metadata
      ) VALUES (
        ${input.principal.userId}, ${input.workspaceId ?? null},
        ${input.principal.clientId}, ${input.toolName},
        ${input.resourceType ?? null}, ${input.resourceId ?? null},
        ${input.outcome}, ${input.errorCode ?? null},
        ${input.requestId ?? randomUUID()}, ${input.idempotencyKey ?? null},
        ${this.sql.json((input.metadata ?? {}) as never)}
      )
    `;
  }
}
