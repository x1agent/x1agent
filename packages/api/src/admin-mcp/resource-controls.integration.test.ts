import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dropTestDb, freshTestDb } from "../test-helpers.js";
import { AdminMcpContextFileControl } from "./context-file-control.js";
import { AdminMcpOciImageControl } from "./oci-image-control.js";
import { AdminMcpCollectionControl } from "./collection-control.js";

const TEST_DB = "x1agent_admin_mcp_resource_controls_test";
let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let userId: string;
let workspaceA: string;
let workspaceB: string;
let agentId: string;

describe("administrative MCP durable resource controls", () => {
  beforeAll(async () => {
    const db = await freshTestDb(TEST_DB);
    dbSql = db.sql;
    const users = await dbSql<{ id: string }[]>`
      INSERT INTO users (email, name)
      VALUES ('resource-controls@example.com', 'Resource Controls')
      RETURNING id
    `;
    userId = users[0]!.id;
    const workspaces = await dbSql<{ id: string; slug: string }[]>`
      INSERT INTO workspaces (slug, name)
      VALUES ('resource-a', 'Resource A'), ('resource-b', 'Resource B')
      RETURNING id, slug
    `;
    workspaceA = workspaces.find((row) => row.slug === "resource-a")!.id;
    workspaceB = workspaces.find((row) => row.slug === "resource-b")!.id;
    const agents = await dbSql<{ id: string }[]>`
      INSERT INTO agents (
        workspace_id, slug, name, runtime_type, kind, created_by
      ) VALUES (
        ${workspaceA}, 'resource-agent', 'Resource Agent', 'claude_code',
        'worker', ${userId}
      ) RETURNING id
    `;
    agentId = agents[0]!.id;
  }, 30_000);

  afterAll(async () => {
    if (dbSql) await dbSql.end();
    await dropTestDb(TEST_DB);
  }, 30_000);

  test("keeps context files workspace-scoped and revision-safe", async () => {
    const files = new AdminMcpContextFileControl(dbSql);
    const created = await files.put({
      workspaceId: workspaceA,
      agentId,
      actorUserId: userId,
      path: "docs/context.md",
      mimeType: "text/markdown",
      content: "first revision",
    });
    expect(created).toMatchObject({ revision: 1, content: "first revision" });
    expect(await files.get(workspaceB, agentId, "docs/context.md")).toBeNull();

    const updated = await files.put({
      workspaceId: workspaceA,
      agentId,
      actorUserId: userId,
      path: "docs/context.md",
      mimeType: "text/markdown",
      content: "second revision",
      expectedRevision: 1,
    });
    expect(updated).toMatchObject({ revision: 2, content: "second revision" });
    await expect(
      files.put({
        workspaceId: workspaceA,
        agentId,
        actorUserId: userId,
        path: "docs/context.md",
        mimeType: "text/markdown",
        content: "stale write",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  test("registers only digest-pinned allowlisted OCI images and can retry validation", async () => {
    const images = new AdminMcpOciImageControl(dbSql, ["ghcr.io"]);
    expect(() =>
      images.parse("evil.example/repo@sha256:" + "a".repeat(64)),
    ).toThrow("allowlisted");

    const requestedRef = `ghcr.io/x1agent/test@sha256:${"b".repeat(64)}`;
    const registered = await images.register({
      workspaceId: workspaceA,
      actorUserId: userId,
      name: "external-test",
      displayName: "External Test",
      ociReference: requestedRef,
    });
    await dbSql`
      UPDATE agent_image_oci_operations SET status = 'failed'
      WHERE image_id = ${registered.id}
    `;
    await dbSql`
      UPDATE agent_images SET build_status = 'failed'
      WHERE id = ${registered.id}
    `;
    expect(
      await images.retry(workspaceB, registered.id, requestedRef),
    ).toBe(false);
    expect(
      await images.retry(workspaceA, registered.id, requestedRef),
    ).toBe(true);
    const rows = await dbSql<{ build_status: string; pending: number }[]>`
      SELECT img.build_status,
        count(op.id) FILTER (WHERE op.status = 'pending')::int AS pending
      FROM agent_images img
      JOIN agent_image_oci_operations op ON op.image_id = img.id
      WHERE img.id = ${registered.id}
      GROUP BY img.build_status
    `;
    expect(rows[0]).toEqual({ build_status: "pending", pending: 1 });
  });

  test("durably advances collection provisioning and deletion", async () => {
    const providerCalls: string[] = [];
    const collections = new AdminMcpCollectionControl(dbSql, {
      provision: async () => {
        providerCalls.push("provision");
      },
      deprovision: async () => {
        providerCalls.push("deprovision");
      },
      discover: async () => [],
      listRecords: async () => [],
    });
    const created = await collections.create({
      workspaceId: workspaceA,
      workspaceSlug: "resource-a",
      actorUserId: userId,
      name: "Knowledge",
      slug: "knowledge",
    });
    expect(created).toMatchObject({ status: "pending" });
    expect(await collections.processNext()).toBe(true);
    expect(await collections.get(workspaceA, String(created.id))).toMatchObject({
      status: "ready",
    });

    const deletion = await collections.requestDelete(
      workspaceA,
      String(created.id),
    );
    expect(deletion).toMatchObject({
      attachmentCount: 0,
      collection: { status: "deleting" },
    });
    expect(await collections.processNext()).toBe(true);
    expect(await collections.get(workspaceA, String(created.id))).toBeNull();
    expect(providerCalls).toEqual(["provision", "deprovision"]);
  });
});
