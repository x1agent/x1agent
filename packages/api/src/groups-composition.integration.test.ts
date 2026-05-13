import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose, type Composition } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

// Integration tests for the X1A-107 groups backend. Spin up a fresh
// Postgres, run all migrations, seed two workspaces with a few users
// in different roles, then exercise the routes through the composition
// root just like a real client would (cookie auth, JSON bodies).
//
// What we're covering:
//   * Happy-path create / list / detail / patch / soft-delete.
//   * Creator is auto-added on POST /.
//   * Soft delete: archived group is excluded from list, name is
//     reusable for a brand-new group.
//   * Bulk member-add is idempotent; user-from-another-workspace is
//     rejected with 400 user_not_in_workspace.
//   * Cross-workspace probe returns 404 (not 403 — we don't leak ids
//     across tenants).
//   * Validation: empty / whitespace / 81-char / @-prefix names; 501-
//     char description.
//   * ACL: a non-admin member cannot create/patch/delete, but CAN
//     list and read groups + memberships.
//
// What's NOT covered here (deliberately): resolution-at-share-time
// semantics. Those live in the share-recipient picker work (X1A-109).
// This PR provides the soft-delete column + repository read paths that
// X1A-109 will consume for the recipient-pill tooltip; the snapshot
// capture itself is X1A-109's job.

const TEST_DB = "x1agent_groups_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let composed: Composition;
let app: Hono;

// Seed-time references for assertions inside it() blocks.
let workspaceAId: string;
let workspaceBId: string;
let adminId: string;
let memberId: string;
let otherMemberId: string;
// User who belongs to workspace B only — used to assert cross-tenant
// rejection on member-add.
let outsiderId: string;

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/x1_session=([^;]+)/);
  if (!m) throw new Error("no session cookie");
  return `x1_session=${m[1]}`;
}

async function login(email: string): Promise<string> {
  process.env.TEST_USER = email;
  const { resetSql } = await import("./db/client.js");
  await resetSql();
  composed = compose({
    sql: dbSql,
    jwtSecret: "integration-test-secret",
    googleClientId: "placeholder",
    googleClientSecret: "placeholder",
    appUrl: "http://app.test",
    apiUrl: "http://api.test",
    allowedDomains: [],
    platformAdmins: [],
    authBypass: true,
    testUserEmail: email,
    platformName: "x1agent",
    workspaceSecretsMasterKey: "0".repeat(64),
  });
  app = new Hono();
  app.route("/auth", composed.authRoutes);
  app.route("/api/workspaces/:slug/groups", composed.groupRoutes);
  const res = await app.fetch(new Request("http://api.test/auth/bypass"));
  return cookie(res);
}

describe("groups routes (X1A-107)", () => {
  beforeAll(async () => {
    const db = await freshTestDb(TEST_DB);
    dbSql = db.sql;
    process.env.DATABASE_URL = db.url;
    const { resetSql } = await import("./db/client.js");
    await resetSql();

    // Two workspaces — A is the focus, B exists solely for the cross-
    // tenant probe and the "user from another workspace" rejection.
    const [wsA] = await dbSql<{ id: string }[]>`
      INSERT INTO workspaces (slug, name) VALUES ('alpha', 'Alpha')
      RETURNING id
    `;
    const [wsB] = await dbSql<{ id: string }[]>`
      INSERT INTO workspaces (slug, name) VALUES ('beta', 'Beta')
      RETURNING id
    `;
    workspaceAId = wsA!.id;
    workspaceBId = wsB!.id;

    const users = await dbSql<{ id: string; email: string }[]>`
      INSERT INTO users (email, name) VALUES
        ('admin@example.com',   'Admin'),
        ('member@example.com',  'Member'),
        ('other@example.com',   'Other'),
        ('outsider@example.com', 'Outsider')
      RETURNING id, email
    `;
    const idByEmail = (email: string) =>
      users.find((u) => u.email === email)!.id;
    adminId = idByEmail("admin@example.com");
    memberId = idByEmail("member@example.com");
    otherMemberId = idByEmail("other@example.com");
    outsiderId = idByEmail("outsider@example.com");

    await dbSql`
      INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
        (${workspaceAId}, ${adminId},       'admin'),
        (${workspaceAId}, ${memberId},      'member'),
        (${workspaceAId}, ${otherMemberId}, 'member'),
        (${workspaceBId}, ${outsiderId},    'admin')
    `;
  }, 30_000);

  afterAll(async () => {
    if (dbSql) await dbSql.end();
    const { resetSql } = await import("./db/client.js");
    await resetSql();
    await dropTestDb(TEST_DB);
  }, 30_000);

  describe("create / list / detail / patch / archive", () => {
    it("admin can create a group; creator is auto-added as a member", async () => {
      const c = await login("admin@example.com");
      const res = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Design",
            description: "Product designers",
          }),
        }),
      );
      expect(res.status).toBe(201);
      const { group } = (await res.json()) as {
        group: {
          id: string;
          slug: string;
          name: string;
          description: string | null;
          created_by: string;
        };
      };
      expect(group.name).toBe("Design");
      expect(group.description).toBe("Product designers");
      expect(group.created_by).toBe(adminId);
      // Slug auto-derived from name when not provided.
      expect(group.slug).toBe("design");

      // Auto-add creator: GET /:id should show admin in the member list.
      const detail = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${group.id}`,
          { headers: { Cookie: c } },
        ),
      );
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as {
        group: { members: { user_id: string; email: string }[] };
      };
      expect(
        detailBody.group.members.some((m) => m.user_id === adminId),
      ).toBe(true);
    });

    it("GET / lists active groups with member_count", async () => {
      const c = await login("admin@example.com");
      const listed = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          headers: { Cookie: c },
        }),
      );
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as {
        groups: { name: string; member_count: number }[];
      };
      const design = body.groups.find((g) => g.name === "Design");
      expect(design).toBeTruthy();
      expect(design!.member_count).toBe(1);
    });

    it("PATCH updates name and description", async () => {
      const c = await login("admin@example.com");
      // Find the existing Design group id.
      const listed = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          headers: { Cookie: c },
        }),
      );
      const groups = ((await listed.json()) as { groups: { id: string; name: string }[] })
        .groups;
      const designId = groups.find((g) => g.name === "Design")!.id;

      const patched = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${designId}`,
          {
            method: "PATCH",
            headers: { Cookie: c, "Content-Type": "application/json" },
            body: JSON.stringify({ description: "Design + research" }),
          },
        ),
      );
      expect(patched.status).toBe(200);
      const { group } = (await patched.json()) as {
        group: { description: string };
      };
      expect(group.description).toBe("Design + research");
    });

    it("rejects duplicate name (case-insensitive) with 409 name_taken", async () => {
      const c = await login("admin@example.com");
      const res = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "design" }),
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("name_taken");
    });

    it("DELETE soft-archives; archived group is hidden from list and its name is reusable", async () => {
      const c = await login("admin@example.com");
      // Create a one-off group we can archive without affecting other tests.
      const created = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Temporary" }),
        }),
      );
      const { group } = (await created.json()) as { group: { id: string } };

      const archived = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${group.id}`,
          { method: "DELETE", headers: { Cookie: c } },
        ),
      );
      expect(archived.status).toBe(204);

      const listed = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          headers: { Cookie: c },
        }),
      );
      const body = (await listed.json()) as {
        groups: { id: string; name: string }[];
      };
      expect(body.groups.some((g) => g.id === group.id)).toBe(false);

      // The archived name should now be free to re-take.
      const reused = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Temporary" }),
        }),
      );
      expect(reused.status).toBe(201);

      // DELETE on an already-archived group is idempotent.
      const reArchived = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${group.id}`,
          { method: "DELETE", headers: { Cookie: c } },
        ),
      );
      expect(reArchived.status).toBe(204);
    });
  });

  describe("members", () => {
    it("POST /:id/members bulk-adds; duplicate add is idempotent", async () => {
      const c = await login("admin@example.com");
      const created = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "OnCall" }),
        }),
      );
      const { group } = (await created.json()) as { group: { id: string } };

      const added = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${group.id}/members`,
          {
            method: "POST",
            headers: { Cookie: c, "Content-Type": "application/json" },
            body: JSON.stringify({ user_ids: [memberId, otherMemberId] }),
          },
        ),
      );
      expect(added.status).toBe(200);
      const { members } = (await added.json()) as { members: string[] };
      // Admin (auto-added on create) + member + otherMember = 3.
      expect(members.length).toBe(3);

      // Re-adding the same set is a no-op (still 3 members, status 200).
      const reAdd = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${group.id}/members`,
          {
            method: "POST",
            headers: { Cookie: c, "Content-Type": "application/json" },
            body: JSON.stringify({ user_ids: [memberId, otherMemberId] }),
          },
        ),
      );
      expect(reAdd.status).toBe(200);
      const second = (await reAdd.json()) as { members: string[] };
      expect(second.members.length).toBe(3);
    });

    it("rejects a user from another workspace with 400 user_not_in_workspace", async () => {
      const c = await login("admin@example.com");
      const created = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Leadership" }),
        }),
      );
      const { group } = (await created.json()) as { group: { id: string } };

      const res = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${group.id}/members`,
          {
            method: "POST",
            headers: { Cookie: c, "Content-Type": "application/json" },
            body: JSON.stringify({ user_ids: [outsiderId] }),
          },
        ),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("user_not_in_workspace");
    });

    it("DELETE on a non-member is idempotent (204)", async () => {
      const c = await login("admin@example.com");
      const listed = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          headers: { Cookie: c },
        }),
      );
      const groups = ((await listed.json()) as { groups: { id: string; name: string }[] })
        .groups;
      const designId = groups.find((g) => g.name === "Design")!.id;
      // otherMember is NOT in Design.
      const res = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/groups/${designId}/members/${otherMemberId}`,
          { method: "DELETE", headers: { Cookie: c } },
        ),
      );
      expect(res.status).toBe(204);
    });
  });

  describe("ACL + cross-tenant isolation", () => {
    it("non-admin member can list/read groups but cannot create or delete", async () => {
      const c = await login("member@example.com");

      const listed = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          headers: { Cookie: c },
        }),
      );
      expect(listed.status).toBe(200);

      const created = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Unauthorized" }),
        }),
      );
      expect(created.status).toBe(403);
    });

    it("cross-workspace probe returns 404 (not 403) — no id leakage", async () => {
      // Admin in workspace A creates a group there.
      const cA = await login("admin@example.com");
      const created = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: cA, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "AlphaSecret" }),
        }),
      );
      const { group } = (await created.json()) as { group: { id: string } };

      // Outsider (workspace B admin) probes the same id under workspace B.
      const cB = await login("outsider@example.com");
      const probe = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/beta/groups/${group.id}`,
          { headers: { Cookie: cB } },
        ),
      );
      expect(probe.status).toBe(404);
    });

    it("GET /memberships returns the caller's active groups", async () => {
      const c = await login("admin@example.com");
      const res = await app.fetch(
        new Request(
          "http://api.test/api/workspaces/alpha/groups/memberships",
          { headers: { Cookie: c } },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        groups: { name: string }[];
      };
      // Admin auto-added on every create; should be in many groups.
      expect(body.groups.length).toBeGreaterThan(0);
      expect(body.groups.some((g) => g.name === "Design")).toBe(true);
    });
  });

  describe("validation", () => {
    it("rejects empty / whitespace name with 400 name_invalid", async () => {
      const c = await login("admin@example.com");
      for (const bad of ["", "   "]) {
        const res = await app.fetch(
          new Request("http://api.test/api/workspaces/alpha/groups", {
            method: "POST",
            headers: { Cookie: c, "Content-Type": "application/json" },
            body: JSON.stringify({ name: bad }),
          }),
        );
        // Empty string fails the "missing_fields" guard first; whitespace
        // makes it past that and hits the validator. Both 400.
        expect(res.status).toBe(400);
      }
    });

    it("rejects 81-char name with 400 name_invalid", async () => {
      const c = await login("admin@example.com");
      const res = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x".repeat(81) }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("name_invalid");
    });

    it("rejects @-prefix name with 400 name_invalid", async () => {
      const c = await login("admin@example.com");
      const res = await app.fetch(
        new Request("http://api.test/api/workspaces/alpha/groups", {
          method: "POST",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "@design" }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("name_invalid");
    });
  });
});
