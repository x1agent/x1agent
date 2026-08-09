import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dropTestDb, freshTestDb } from "../test-helpers.js";
import { PostgresAdminMcpOAuthStore, type OAuthPrincipal } from "./oauth-store.js";
import {
  PostgresAdminMcpOperationStore,
  adminMcpRequestHash,
} from "./operation-store.js";

const TEST_DB = "x1agent_admin_mcp_operation_test";
let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let store: PostgresAdminMcpOperationStore;
let principal: OAuthPrincipal;
let workspaceId: string;

describe("PostgresAdminMcpOperationStore", () => {
  beforeAll(async () => {
    const db = await freshTestDb(TEST_DB);
    dbSql = db.sql;
    const users = await dbSql<{ id: string }[]>`
      INSERT INTO users (email, name)
      VALUES ('operations@example.com', 'Operations User') RETURNING id
    `;
    const workspaces = await dbSql<{ id: string }[]>`
      INSERT INTO workspaces (slug, name) VALUES ('operations', 'Operations')
      RETURNING id
    `;
    workspaceId = workspaces[0]!.id;
    const oauth = new PostgresAdminMcpOAuthStore(dbSql);
    const client = await oauth.registerClient({
      clientName: "Codex",
      redirectUris: ["http://127.0.0.1:49123/callback"],
    });
    principal = {
      userId: users[0]!.id,
      clientId: client.clientId,
      scopes: ["x1.agents.write"],
      expiresAt: 2_000_000_000,
    };
    store = new PostgresAdminMcpOperationStore(dbSql);
  }, 30_000);

  afterAll(async () => {
    if (dbSql) await dbSql.end();
    await dropTestDb(TEST_DB);
  }, 30_000);

  test("claims, detects conflicts, replays sanitized results, and records audit", async () => {
    const requestHash = adminMcpRequestHash({ name: "Researcher", slug: "researcher" });
    const key = "agent-create-1";
    expect(
      await store.claim({
        principal,
        toolName: "agents.create",
        idempotencyKey: key,
        requestHash,
      }),
    ).toEqual({ kind: "acquired" });
    expect(
      await store.claim({
        principal,
        toolName: "agents.create",
        idempotencyKey: key,
        requestHash,
      }),
    ).toEqual({ kind: "in_progress" });
    expect(
      await store.claim({
        principal,
        toolName: "agents.create",
        idempotencyKey: key,
        requestHash: adminMcpRequestHash({ name: "Different" }),
      }),
    ).toEqual({ kind: "conflict" });

    await store.complete({
      principal,
      toolName: "agents.create",
      idempotencyKey: key,
      resourceId: "agent-1",
      result: { agent: { id: "agent-1" } },
    });
    expect(
      await store.claim({
        principal,
        toolName: "agents.create",
        idempotencyKey: key,
        requestHash,
      }),
    ).toEqual({ kind: "replay", result: { agent: { id: "agent-1" } } });

    await store.audit({
      principal,
      workspaceId,
      toolName: "agents.create",
      resourceType: "agents",
      resourceId: "agent-1",
      outcome: "success",
      idempotencyKey: key,
      metadata: { changed_fields: ["name", "slug"] },
    });
    const audit = await dbSql<{
      source: string;
      actor_user_id: string;
      workspace_id: string;
      metadata: Record<string, unknown>;
    }[]>`
      SELECT source, actor_user_id, workspace_id, metadata
      FROM admin_audit_events WHERE tool_name = 'agents.create'
    `;
    expect(audit[0]).toMatchObject({
      source: "mcp",
      actor_user_id: principal.userId,
      workspace_id: workspaceId,
      metadata: { changed_fields: ["name", "slug"] },
    });
  });

  test("allows an identical failed operation to be retried", async () => {
    const input = {
      principal,
      toolName: "collections.create",
      idempotencyKey: "collection-1",
      requestHash: adminMcpRequestHash({ slug: "knowledge" }),
    };
    expect(await store.claim(input)).toEqual({ kind: "acquired" });
    await store.fail(input);
    expect(await store.claim(input)).toEqual({ kind: "acquired" });
  });

  test("reclaims an abandoned in-progress operation after its lease", async () => {
    const input = {
      principal,
      toolName: "agents.delete",
      idempotencyKey: "abandoned-delete-1",
      requestHash: adminMcpRequestHash({ agent: "agent-1" }),
    };
    expect(await store.claim(input)).toEqual({ kind: "acquired" });
    await dbSql`
      UPDATE admin_mcp_idempotency
      SET updated_at = now() - interval '16 minutes'
      WHERE actor_user_id = ${principal.userId}
        AND oauth_client_id = ${principal.clientId}
        AND tool_name = ${input.toolName}
        AND idempotency_key = ${input.idempotencyKey}
    `;
    expect(await store.claim(input)).toEqual({ kind: "acquired" });
  });
});
