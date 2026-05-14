import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_members_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let app: Hono;
let WS_A: string;
let WS_B: string;
let ADMIN_A: string;
let MEMBER_A: string;
let OWNER_A: string;
let ADMIN_B: string;

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/x1_session=([^;]+)/);
  if (!m) throw new Error("no session cookie on response");
  return `x1_session=${m[1]}`;
}

async function loginAs(email: string): Promise<string> {
  process.env.TEST_USER = email;
  const res = await app.fetch(new Request("http://api.test/auth/bypass"));
  return cookie(res);
}

describe("workspace member routes", () => {
  beforeAll(async () => {
    const db = await freshTestDb(TEST_DB);
    dbSql = db.sql;
    process.env.DATABASE_URL = db.url;
    const { resetSql } = await import("./db/client.js");
    await resetSql();

    // Two workspaces to exercise tenant-isolation.
    const wsRows = await dbSql<{ id: string; slug: string }[]>`
      INSERT INTO workspaces (slug, name) VALUES
        ('ws-a', 'Workspace A'),
        ('ws-b', 'Workspace B')
      RETURNING id, slug
    `;
    WS_A = wsRows.find((r) => r.slug === "ws-a")!.id;
    WS_B = wsRows.find((r) => r.slug === "ws-b")!.id;

    const userRows = await dbSql<{ id: string; email: string }[]>`
      INSERT INTO users (email, name) VALUES
        ('admin-a@example.com',  'Admin A'),
        ('member-a@example.com', 'Member A'),
        ('owner-a@example.com',  'Owner A'),
        ('admin-b@example.com',  'Admin B')
      RETURNING id, email
    `;
    ADMIN_A = userRows.find((u) => u.email === "admin-a@example.com")!.id;
    MEMBER_A = userRows.find((u) => u.email === "member-a@example.com")!.id;
    OWNER_A = userRows.find((u) => u.email === "owner-a@example.com")!.id;
    ADMIN_B = userRows.find((u) => u.email === "admin-b@example.com")!.id;

    await dbSql`
      INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
        (${WS_A}, ${ADMIN_A},  'admin'),
        (${WS_A}, ${MEMBER_A}, 'member'),
        (${WS_A}, ${OWNER_A},  'owner'),
        (${WS_B}, ${ADMIN_B},  'admin')
    `;

    const composed = compose({
      sql: dbSql,
      jwtSecret: "integration-test-secret",
      googleClientId: "placeholder",
      googleClientSecret: "placeholder",
      appUrl: "http://app.test",
      apiUrl: "http://api.test",
      allowedDomains: [],
      platformAdmins: [],
      authBypass: true,
      testUserEmail: "admin-a@example.com",
      platformName: "x1agent",
      workspaceSecretsMasterKey: "0".repeat(64),
    });

    app = new Hono();
    app.route("/auth", composed.authRoutes);
    app.route("/api/workspaces/:slug/members", composed.workspaceMembersRoutes);
  }, 30_000);

  afterAll(async () => {
    if (dbSql) await dbSql.end();
    const { resetSql } = await import("./db/client.js");
    await resetSql();
    await dropTestDb(TEST_DB);
  }, 30_000);

  describe("GET /api/workspaces/:slug/members", () => {
    it("returns all members for any caller who is a member", async () => {
      const session = await loginAs("member-a@example.com");
      const res = await app.fetch(
        new Request("http://api.test/api/workspaces/ws-a/members", {
          headers: { cookie: session },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: { email: string }[] };
      const emails = body.members.map((m) => m.email).sort();
      expect(emails).toEqual([
        "admin-a@example.com",
        "member-a@example.com",
        "owner-a@example.com",
      ]);
    });

    it("rejects a non-member with 403", async () => {
      const session = await loginAs("admin-b@example.com");
      const res = await app.fetch(
        new Request("http://api.test/api/workspaces/ws-a/members", {
          headers: { cookie: session },
        }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /api/workspaces/:slug/members/:userId", () => {
    it("an admin can promote a member to admin", async () => {
      const session = await loginAs("admin-a@example.com");
      const res = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/ws-a/members/${MEMBER_A}`,
          {
            method: "PATCH",
            headers: { cookie: session, "content-type": "application/json" },
            body: JSON.stringify({ role: "admin" }),
          },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { member: { role: string } };
      expect(body.member.role).toBe("admin");
      // Restore role to keep later tests' expectations stable.
      await app.fetch(
        new Request(
          `http://api.test/api/workspaces/ws-a/members/${MEMBER_A}`,
          {
            method: "PATCH",
            headers: { cookie: session, "content-type": "application/json" },
            body: JSON.stringify({ role: "member" }),
          },
        ),
      );
    });

    it("a member cannot edit roles (403)", async () => {
      const session = await loginAs("member-a@example.com");
      const res = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/ws-a/members/${ADMIN_A}`,
          {
            method: "PATCH",
            headers: { cookie: session, "content-type": "application/json" },
            body: JSON.stringify({ role: "member" }),
          },
        ),
      );
      expect(res.status).toBe(403);
    });

    it("an admin of WS_B cannot edit a member of WS_A (cross-tenant)", async () => {
      const session = await loginAs("admin-b@example.com");
      const res = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/ws-a/members/${MEMBER_A}`,
          {
            method: "PATCH",
            headers: { cookie: session, "content-type": "application/json" },
            body: JSON.stringify({ role: "admin" }),
          },
        ),
      );
      expect(res.status).toBe(403);
    });

    it("refuses to demote the last admin/owner (409 last_admin)", async () => {
      // First, demote OWNER_A → member so only ADMIN_A is left elevated.
      const session = await loginAs("admin-a@example.com");
      const demote = await app.fetch(
        new Request(`http://api.test/api/workspaces/ws-a/members/${OWNER_A}`, {
          method: "PATCH",
          headers: { cookie: session, "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        }),
      );
      expect(demote.status).toBe(200);

      // Now try to demote ADMIN_A → should refuse (last admin).
      const res = await app.fetch(
        new Request(`http://api.test/api/workspaces/ws-a/members/${ADMIN_A}`, {
          method: "PATCH",
          headers: { cookie: session, "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("last_admin");

      // Restore OWNER_A.
      await app.fetch(
        new Request(`http://api.test/api/workspaces/ws-a/members/${OWNER_A}`, {
          method: "PATCH",
          headers: { cookie: session, "content-type": "application/json" },
          body: JSON.stringify({ role: "owner" }),
        }),
      );
    });
  });

  describe("DELETE /api/workspaces/:slug/members/:userId", () => {
    it("an admin can remove a plain member", async () => {
      // Seed a removable member.
      const userRows = await dbSql<{ id: string }[]>`
        INSERT INTO users (email, name) VALUES ('ephemeral@example.com', 'Ephemeral')
        RETURNING id
      `;
      const ephemeral = userRows[0]!.id;
      await dbSql`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${WS_A}, ${ephemeral}, 'member')
      `;
      const session = await loginAs("admin-a@example.com");
      const res = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/ws-a/members/${ephemeral}`,
          { method: "DELETE", headers: { cookie: session } },
        ),
      );
      expect(res.status).toBe(204);
      const rows = await dbSql`
        SELECT 1 FROM workspace_members
        WHERE workspace_id = ${WS_A} AND user_id = ${ephemeral}
      `;
      expect(rows.length).toBe(0);
    });

    it("an admin of WS_B cannot remove a member of WS_A (cross-tenant)", async () => {
      const session = await loginAs("admin-b@example.com");
      const res = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/ws-a/members/${MEMBER_A}`,
          { method: "DELETE", headers: { cookie: session } },
        ),
      );
      expect(res.status).toBe(403);
      // Membership row still there.
      const rows = await dbSql`
        SELECT 1 FROM workspace_members
        WHERE workspace_id = ${WS_A} AND user_id = ${MEMBER_A}
      `;
      expect(rows.length).toBe(1);
    });
  });
});
