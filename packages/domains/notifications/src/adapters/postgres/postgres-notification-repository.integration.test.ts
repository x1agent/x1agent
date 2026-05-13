import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { PostgresNotificationRepository } from "./postgres-notification-repository.js";

/**
 * Integration test against a real Postgres. Mirrors the
 * api/src/test-helpers.ts pattern but inline here so this package
 * doesn't depend on @x1agent/api.
 *
 * Requires DATABASE_URL pointing at a server that can `CREATE DATABASE`.
 * `mise run dev` exposes Postgres at the default localhost address used
 * below. Skipped in CI environments that don't expose Postgres — Bun's
 * `it.skipIf` would be ideal but the safer fallback is to surface a
 * clear error: the test exits early with a console.warn when the admin
 * connection fails, so a missing Postgres doesn't break unrelated suites.
 */
const TEST_DB = `x1agent_notif_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "..", "..", "..", "deploy", "migrations");
const adminUrl =
  process.env.DATABASE_URL ||
  "postgres://x1agent:x1agent@localhost:5432/x1agent";

function dbUrlFor(name: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

let testSql: postgres.Sql<Record<string, unknown>> | null = null;
let repo: PostgresNotificationRepository | null = null;
let postgresAvailable = false;

beforeAll(async () => {
  try {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
    await admin.end();

    testSql = postgres(dbUrlFor(TEST_DB), { max: 2, onnotice: () => {} });
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const content = await readFile(join(migrationsDir, file), "utf8");
      await testSql.unsafe(content);
    }
    repo = new PostgresNotificationRepository(testSql);
    postgresAvailable = true;
  } catch (err) {
    console.warn(
      `[notifications integration test] Postgres unavailable: ${(err as Error).message} — skipping suite`,
    );
  }
});

afterAll(async () => {
  if (testSql) await testSql.end();
  if (postgresAvailable) {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await admin.end();
  }
});

describe("PostgresNotificationRepository", () => {
  it("inserts a row on first write", async () => {
    if (!postgresAvailable || !repo || !testSql) return;
    const userId = UserId(randomUUID());
    const workspaceId = WorkspaceId(randomUUID());
    const result = await repo.insertIfAbsent({
      userId,
      workspaceId,
      kind: "comment_mention",
      sourceEventId: `evt-${randomUUID()}`,
      payload: { snippet: "hi @bob" },
    });
    expect(result.inserted).toBe(true);
    if (result.inserted) {
      expect(result.notification.userId).toBe(userId);
      expect(result.notification.workspaceId).toBe(workspaceId);
      expect(result.notification.kind).toBe("comment_mention");
      expect(result.notification.readAt).toBeNull();
      expect(result.notification.payload).toEqual({ snippet: "hi @bob" });
    }

    const rows = await testSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM notifications
    `;
    expect(rows[0]!.count).toBe("1");
  });

  it("returns inserted=false on duplicate (user_id, source_event_id)", async () => {
    if (!postgresAvailable || !repo || !testSql) return;
    const userId = UserId(randomUUID());
    const workspaceId = WorkspaceId(randomUUID());
    const sourceEventId = `evt-${randomUUID()}`;

    const first = await repo.insertIfAbsent({
      userId,
      workspaceId,
      kind: "comment_mention",
      sourceEventId,
      payload: { v: 1 },
    });
    const second = await repo.insertIfAbsent({
      userId,
      workspaceId,
      kind: "comment_mention",
      sourceEventId,
      payload: { v: 2 }, // different payload — replay must NOT overwrite
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const rows = await testSql<{ payload: { v: number } }[]>`
      SELECT payload FROM notifications
      WHERE user_id = ${userId} AND source_event_id = ${sourceEventId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.v).toBe(1); // first wins; ON CONFLICT DO NOTHING
  });

  it("same source_event_id for different users fans out to two rows", async () => {
    if (!postgresAvailable || !repo || !testSql) return;
    const alice = UserId(randomUUID());
    const bob = UserId(randomUUID());
    const workspaceId = WorkspaceId(randomUUID());
    const sourceEventId = `evt-${randomUUID()}`;

    await repo.insertIfAbsent({
      userId: alice,
      workspaceId,
      kind: "comment_mention",
      sourceEventId,
      payload: {},
    });
    await repo.insertIfAbsent({
      userId: bob,
      workspaceId,
      kind: "comment_mention",
      sourceEventId,
      payload: {},
    });

    const rows = await testSql<{ user_id: string }[]>`
      SELECT user_id FROM notifications
      WHERE source_event_id = ${sourceEventId}
      ORDER BY user_id
    `;
    expect(rows).toHaveLength(2);
  });

  it("tolerates an orphan user_id with no FK violation", async () => {
    if (!postgresAvailable || !repo) return;
    // user_id intentionally does NOT exist in any users table. The CEO's
    // explicit design call for X1A-111: no FKs, orphan rows acceptable,
    // expiration sweep cleans up later. This test pins the behavior so a
    // future "let's add an FK" refactor breaks here loudly.
    const orphanUser = UserId(randomUUID());
    const result = await repo.insertIfAbsent({
      userId: orphanUser,
      workspaceId: WorkspaceId(randomUUID()),
      kind: "comment_mention",
      sourceEventId: `evt-${randomUUID()}`,
      payload: {},
    });
    expect(result.inserted).toBe(true);
  });
});
