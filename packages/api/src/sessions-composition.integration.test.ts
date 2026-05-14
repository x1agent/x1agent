import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_sessions_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let app: Hono;
let composed: ReturnType<typeof compose>;

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
  // Stranger is in the users table but NOT in workspace_members for
  // 'default' — exercises the non-member gate independently of the
  // member-vs-admin role check.
  await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('stranger@example.com', 'Stranger')
    RETURNING id
  `;
  await dbSql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${ws!.id}, ${admin!.id}, 'admin'),
           (${ws!.id}, ${member!.id}, 'member')
  `;

  process.env.TEST_USER = "admin@example.com";

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
    testUserEmail: "admin@example.com",
    platformName: "x1agent",
    workspaceSecretsMasterKey: "0".repeat(64),
  });

  app = new Hono();
  app.route("/auth", composed.authRoutes);
  app.route("/api/workspaces/:slug/agents", composed.agentRoutes);
  app.route(
    "/api/workspaces/:slug/agents/:agentId/sessions",
    composed.sessionRoutes,
  );
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
  const { resetSql } = await import("./db/client.js");
  await resetSql();
  const fresh = compose({
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
  const app2 = new Hono();
  app2.route("/auth", fresh.authRoutes);
  const res = await app2.fetch(new Request("http://api.test/auth/bypass"));
  return cookie(res);
}

async function newAgent(c: string, slug: string, schedule: string | null) {
  const res = await app.fetch(
    new Request("http://api.test/api/workspaces/default/agents", {
      method: "POST",
      headers: { Cookie: c, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        name: slug,
        runtime_type: "claude_code",
        schedule,
      }),
    }),
  );
  expect(res.status).toBe(201);
  const { agent } = (await res.json()) as { agent: { id: string } };
  return agent.id;
}

describe("session routes", () => {
  it("admin can trigger and list sessions for an agent", async () => {
    const c = await login("admin@example.com");
    const id = await newAgent(c, "heartbeat-run", null);

    const triggered = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions`,
        { method: "POST", headers: { Cookie: c } },
      ),
    );
    expect(triggered.status).toBe(201);
    const { session } = (await triggered.json()) as {
      session: {
        id: string;
        agent_id: string;
        triggered_by: string;
        status: string;
      };
    };
    expect(session.triggered_by).toBe("user");
    expect(session.status).toBe("pending");
    expect(session.agent_id).toBe(id);

    const listed = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions`,
        { headers: { Cookie: c } },
      ),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      sessions: { id: string }[];
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe(session.id);
  });

  it("member (non-admin) can trigger a session (X1A-126)", async () => {
    const adminC = await login("admin@example.com");
    const id = await newAgent(adminC, "member-trigger", null);

    const memberC = await login("member@example.com");
    const res = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions`,
        { method: "POST", headers: { Cookie: memberC } },
      ),
    );
    // Run-time chat is a member-level capability — admin only gates
    // management (bulk delete, listing other people's sessions).
    expect(res.status).toBe(201);
  });

  it("non-member cannot trigger a session", async () => {
    const adminC = await login("admin@example.com");
    const id = await newAgent(adminC, "no-trigger-stranger", null);

    const strangerC = await login("stranger@example.com");
    const res = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions`,
        { method: "POST", headers: { Cookie: strangerC } },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("cancel marks a pending session complete with cancelled errorMessage", async () => {
    const c = await login("admin@example.com");
    const id = await newAgent(c, "to-cancel", null);

    const triggered = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions`,
        { method: "POST", headers: { Cookie: c } },
      ),
    );
    const { session } = (await triggered.json()) as {
      session: { id: string };
    };

    const cancelled = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions/${session.id}/cancel`,
        { method: "POST", headers: { Cookie: c } },
      ),
    );
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as {
      session: { status: string; error_message: string | null };
    };
    expect(body.session.status).toBe("complete");
    expect(body.session.error_message).toBe("cancelled");
  });

  it("returns 404 when trying to access a session under the wrong agent", async () => {
    const c = await login("admin@example.com");
    const id1 = await newAgent(c, "ag-one", null);
    const id2 = await newAgent(c, "ag-two", null);

    const triggered = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id1}/sessions`,
        { method: "POST", headers: { Cookie: c } },
      ),
    );
    const { session } = (await triggered.json()) as { session: { id: string } };

    const wrong = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id2}/sessions/${session.id}/cancel`,
        { method: "POST", headers: { Cookie: c } },
      ),
    );
    expect(wrong.status).toBe(404);
  });

  it("tickScheduler fires a run for an agent with an elapsed cron slot", async () => {
    const c = await login("admin@example.com");
    const id = await newAgent(c, "every-min", "@every 1m");

    // Seed a prior scheduler row 80s ago so the next slot is ~20s overdue.
    // The no-backfill policy skips firing when the missed slot is more than
    // one full interval behind; here the slot is 20s past on a 60s interval,
    // which is firmly inside the threshold and should fire.
    await dbSql`
      INSERT INTO sessions (agent_id, triggered_by, triggered_by_user_id, triggered_at)
      VALUES (${id}, 'scheduler', NULL, now() - interval '80 seconds')
    `;

    const result = await composed.tickScheduler();
    expect(result.created).toBeGreaterThanOrEqual(1);

    const listed = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions`,
        { headers: { Cookie: c } },
      ),
    );
    const body = (await listed.json()) as {
      sessions: { triggered_by: string }[];
    };
    expect(body.sessions.some((s) => s.triggered_by === "scheduler")).toBe(
      true,
    );
  });

  it("scheduler does not fire again once the agent is caught up", async () => {
    const c = await login("admin@example.com");
    const id = await newAgent(c, "caught-up", "@every 5m");
    // Seed only 30s back, so nextDue is ~4.5 min in the future.
    await dbSql`
      INSERT INTO sessions (agent_id, triggered_by, triggered_by_user_id, triggered_at)
      VALUES (${id}, 'scheduler', NULL, now() - interval '30 seconds')
    `;

    await composed.tickScheduler();
    await composed.tickScheduler();
    await composed.tickScheduler();

    // Other tests leave behind scheduled agents that will fire; scope the
    // assertion to this agent only.
    const listed = await app.fetch(
      new Request(
        `http://api.test/api/workspaces/default/agents/${id}/sessions`,
        { headers: { Cookie: c } },
      ),
    );
    const body = (await listed.json()) as { sessions: unknown[] };
    // seed + nothing new for this agent
    expect(body.sessions).toHaveLength(1);
  });

  it("unique (agent_id, triggered_at) survives a duplicate insert", async () => {
    const c = await login("admin@example.com");
    const id = await newAgent(c, "unique-idx", null);
    const at = new Date("2026-04-18T09:00:00Z");
    await dbSql`
      INSERT INTO sessions (agent_id, triggered_by, triggered_by_user_id, triggered_at)
      VALUES (${id}, 'scheduler', NULL, ${at})
    `;
    let code: string | null = null;
    try {
      await dbSql`
        INSERT INTO sessions (agent_id, triggered_by, triggered_by_user_id, triggered_at)
        VALUES (${id}, 'scheduler', NULL, ${at})
      `;
    } catch (err) {
      code = (err as { code?: string }).code ?? null;
    }
    expect(code).toBe("23505");
  });
});
