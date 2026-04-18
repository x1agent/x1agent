import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_invitations_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let app: Hono;

beforeAll(async () => {
  const db = await freshTestDb(TEST_DB);
  dbSql = db.sql;
  process.env.DATABASE_URL = db.url;
  const { resetSql } = await import("./db/client.js");
  await resetSql();

  const [ws] = await dbSql<{ id: string }[]>`
    INSERT INTO workspaces (slug, name) VALUES ('default', 'Default')
    RETURNING id
  `;
  const [admin] = await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('admin@example.com', 'Admin')
    RETURNING id
  `;
  await dbSql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${ws!.id}, ${admin!.id}, 'admin')
  `;
  process.env.TEST_USER = "admin@example.com";

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
    testUserEmail: "admin@example.com",
    platformName: "x1agent",
  });

  app = new Hono();
  app.route("/auth", composed.authRoutes);
  app.route(
    "/api/workspaces/:slug/invitations",
    composed.workspaceInvitationRoutes,
  );
  app.route("/api/invitations", composed.publicInvitationRoutes);
});

afterAll(async () => {
  if (dbSql) await dbSql.end();
  const { resetSql } = await import("./db/client.js");
  await resetSql();
  await dropTestDb(TEST_DB);
});

function cookie(res: Response): string {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/x1_session=([^;]+)/);
  if (!m) throw new Error("no session cookie on response");
  return `x1_session=${m[1]}`;
}

async function loginAsAdmin(): Promise<string> {
  const res = await app.fetch(new Request("http://api.test/auth/bypass"));
  return cookie(res);
}

describe("workspace invitation routes (admin-scoped)", () => {
  it("admin can create + list + revoke an invitation", async () => {
    const c = await loginAsAdmin();

    const created = await app.fetch(
      new Request("http://api.test/api/workspaces/default/invitations", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com", role: "member" }),
      }),
    );
    expect(created.status).toBe(201);
    const { invitation } = (await created.json()) as {
      invitation: { id: string; email: string; token: string };
    };
    expect(invitation.email).toBe("bob@example.com");
    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/);

    const listed = await app.fetch(
      new Request("http://api.test/api/workspaces/default/invitations", {
        headers: { Cookie: c },
      }),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      invitations: { id: string }[];
    };
    expect(body.invitations.some((i) => i.id === invitation.id)).toBe(true);

    const revoked = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/invitations/${invitation.id}`,
        { method: "DELETE", headers: { Cookie: c } },
      ),
    );
    expect(revoked.status).toBe(200);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app.fetch(
      new Request("http://api.test/api/workspaces/default/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@example.com" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("409 when a pending invitation already exists for the same email", async () => {
    const c = await loginAsAdmin();
    await app.fetch(
      new Request("http://api.test/api/workspaces/default/invitations", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "duplicate@example.com" }),
      }),
    );
    const second = await app.fetch(
      new Request("http://api.test/api/workspaces/default/invitations", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "duplicate@example.com" }),
      }),
    );
    expect(second.status).toBe(409);
  });
});

describe("public invitation routes", () => {
  it("GET /:token returns workspace info + invitation state", async () => {
    const c = await loginAsAdmin();
    const created = await app.fetch(
      new Request("http://api.test/api/workspaces/default/invitations", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "charlie@example.com" }),
      }),
    );
    const { invitation } = (await created.json()) as {
      invitation: { token: string };
    };

    const res = await app.fetch(
      new Request(`http://api.test/api/invitations/${invitation.token}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      workspace: { slug: string; name: string };
    };
    expect(body.email).toBe("charlie@example.com");
    expect(body.workspace.slug).toBe("default");
  });

  it("404 for a bogus token", async () => {
    const res = await app.fetch(
      new Request("http://api.test/api/invitations/nonsense"),
    );
    expect(res.status).toBe(404);
  });
});
