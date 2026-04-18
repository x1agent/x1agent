import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_agents_test";

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
  const [member] = await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('member@example.com', 'Member')
    RETURNING id
  `;
  await dbSql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${ws!.id}, ${admin!.id}, 'admin'),
           (${ws!.id}, ${member!.id}, 'member')
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
  app.route("/api/workspaces/:slug/agents", composed.agentRoutes);
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
  if (!m) throw new Error("no session cookie");
  return `x1_session=${m[1]}`;
}

async function login(email: string): Promise<string> {
  process.env.TEST_USER = email;
  // re-compose so the bypass provider knows the new email
  const { resetSql } = await import("./db/client.js");
  await resetSql();
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
    testUserEmail: email,
    platformName: "x1agent",
  });
  // replace the app's auth routes with the fresh composition for this login
  const fresh = new Hono();
  fresh.route("/auth", composed.authRoutes);
  const res = await fresh.fetch(new Request("http://api.test/auth/bypass"));
  return cookie(res);
}

describe("agent routes", () => {
  it("admin can create, list, get, update, and delete an agent", async () => {
    const c = await login("admin@example.com");

    const created = await app.fetch(
      new Request("http://api.test/api/workspaces/default/agents", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "heartbeat",
          name: "Heartbeat",
          runtime_type: "claude_code",
          schedule: "@hourly",
          heartbeat_md: "check the dashboards",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as {
      agent: { id: string; slug: string; schedule: string };
    };
    expect(agent.slug).toBe("heartbeat");
    expect(agent.schedule).toBe("@hourly");

    const listed = await app.fetch(
      new Request("http://api.test/api/workspaces/default/agents", {
        headers: { Cookie: c },
      }),
    );
    const body = (await listed.json()) as { agents: { id: string }[] };
    expect(body.agents).toHaveLength(1);

    const patched = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${agent.id}`,
        {
          method: "PATCH",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ schedule: "@daily", is_active: false }),
        },
      ),
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      agent: { schedule: string; is_active: boolean };
    };
    expect(patchedBody.agent.schedule).toBe("@daily");
    expect(patchedBody.agent.is_active).toBe(false);

    const deleted = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${agent.id}`,
        { method: "DELETE", headers: { Cookie: c } },
      ),
    );
    expect(deleted.status).toBe(200);
  });

  it("rejects duplicate slug in the same workspace", async () => {
    const c = await login("admin@example.com");
    await app.fetch(
      new Request("http://api.test/api/workspaces/default/agents", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "dup",
          name: "One",
          runtime_type: "claude_code",
        }),
      }),
    );
    const second = await app.fetch(
      new Request("http://api.test/api/workspaces/default/agents", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "dup",
          name: "Two",
          runtime_type: "claude_code",
        }),
      }),
    );
    expect(second.status).toBe(409);
  });

  it("member cannot create an agent", async () => {
    const c = await login("member@example.com");
    const res = await app.fetch(
      new Request("http://api.test/api/workspaces/default/agents", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "forbidden",
          name: "Forbidden",
          runtime_type: "claude_code",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("unauthenticated requests are rejected", async () => {
    const res = await app.fetch(
      new Request("http://api.test/api/workspaces/default/agents"),
    );
    expect(res.status).toBe(401);
  });

  it("rejects invalid cron schedule", async () => {
    const c = await login("admin@example.com");
    const res = await app.fetch(
      new Request("http://api.test/api/workspaces/default/agents", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "badcron",
          name: "Bad",
          runtime_type: "claude_code",
          schedule: "not a cron",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
