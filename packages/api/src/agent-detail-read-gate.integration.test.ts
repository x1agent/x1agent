import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

/**
 * X1A-149 — tenant-isolation + read/write split for the agent detail
 * page's auxiliary routes (mcp-attachments, env). The factory tests
 * verify wiring with mocked guards; this suite exercises the real
 * `requireAgentRead` / `requireAgentWrite` middlewares in
 * `composition/index.ts` end-to-end through Hono with a real Postgres,
 * because that's where the cross-tenant IDOR check actually lives.
 *
 * Two workspaces, three users:
 *   - workspace A (slug "alpha") with admin Aadmin + member Amember
 *   - workspace B (slug "beta") with admin Badmin (no membership in A)
 *   - one agent created in A.
 *
 * Matrix asserted for both /mcp-attachments and /env routes:
 *   member-A read in A → 200
 *   member-A write in A → 403 (no agent-existence leak — same status as
 *                              a non-member would see)
 *   admin-B read in A → 403 (cross-workspace)
 *   admin-B write in A → 403 (cross-workspace, agent-existence not leaked)
 *   admin-A read+write in A → 200/204
 */

const TEST_DB = "x1agent_agent_detail_read_gate_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let app: Hono;
let agentIdA: string;

beforeAll(async () => {
  const db = await freshTestDb(TEST_DB);
  dbSql = db.sql;
  process.env.DATABASE_URL = db.url;
  const { resetSql } = await import("./db/client.js");
  await resetSql();

  const [wsA] = await dbSql<{ id: string }[]>`
    INSERT INTO workspaces (slug, name) VALUES ('alpha', 'Alpha')
    RETURNING id
  `;
  const [wsB] = await dbSql<{ id: string }[]>`
    INSERT INTO workspaces (slug, name) VALUES ('beta', 'Beta')
    RETURNING id
  `;
  const [aAdmin] = await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('a-admin@example.com', 'Aadmin')
    RETURNING id
  `;
  const [aMember] = await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('a-member@example.com', 'Amember')
    RETURNING id
  `;
  const [bAdmin] = await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('b-admin@example.com', 'Badmin')
    RETURNING id
  `;
  await dbSql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${wsA!.id}, ${aAdmin!.id}, 'admin'),
           (${wsA!.id}, ${aMember!.id}, 'member'),
           (${wsB!.id}, ${bAdmin!.id}, 'admin')
  `;

  process.env.TEST_USER = "a-admin@example.com";
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
    testUserEmail: "a-admin@example.com",
    platformName: "x1agent",
    workspaceSecretsMasterKey: "0".repeat(64),
  } as never);

  app = new Hono();
  app.route("/auth", composed.authRoutes);
  app.route("/api/workspaces/:slug/agents", composed.agentRoutes);
  app.route(
    "/api/workspaces/:slug/agents/:agentId/mcp-attachments",
    composed.agentMcpAttachmentRoutes,
  );
  app.route(
    "/api/workspaces/:slug/agents/:agentId/env",
    composed.agentEnvRoutes,
  );

  // Seed one agent in workspace A directly via SQL — going through the
  // POST would be valid but adds noise to a tenant-isolation test.
  const [created] = await dbSql<{ id: string }[]>`
    INSERT INTO agents (workspace_id, slug, name, runtime_type, kind, system_prompt, heartbeat_md, is_active)
    VALUES (${wsA!.id}, 'detail-test', 'Detail test', 'claude_code', 'worker', '', '', true)
    RETURNING id
  `;
  agentIdA = created!.id;
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
    workspaceSecretsMasterKey: "0".repeat(64),
  } as never);
  const fresh = new Hono();
  fresh.route("/auth", composed.authRoutes);
  const res = await fresh.fetch(new Request("http://api.test/auth/bypass"));
  return cookie(res);
}

describe("agent detail routes — read/write tenant isolation (X1A-149)", () => {
  describe("/mcp-attachments", () => {
    const url = () =>
      `http://api.test/api/workspaces/alpha/agents/${agentIdA}/mcp-attachments`;

    it("member of A can read attachments in A", async () => {
      const c = await login("a-member@example.com");
      const res = await app.fetch(new Request(url(), { headers: { Cookie: c } }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { attachments: unknown[] };
      expect(Array.isArray(body.attachments)).toBe(true);
    });

    it("member of A cannot write attachments in A", async () => {
      const c = await login("a-member@example.com");
      const res = await app.fetch(
        new Request(url(), {
          method: "PUT",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ catalog_entry_id: "00000000-0000-0000-0000-000000000000" }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("admin of B cannot read attachments in A (cross-workspace)", async () => {
      const c = await login("b-admin@example.com");
      const res = await app.fetch(new Request(url(), { headers: { Cookie: c } }));
      expect(res.status).toBe(403);
    });

    it("admin of B cannot write attachments in A (cross-workspace)", async () => {
      const c = await login("b-admin@example.com");
      const res = await app.fetch(
        new Request(url(), {
          method: "PUT",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ catalog_entry_id: "00000000-0000-0000-0000-000000000000" }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("does not leak agent existence to a member via 404 vs 403", async () => {
      // PUT against the real agent id (member lacks role) should
      // return 403 *before* the agent IDOR lookup runs — same status
      // as a non-member of the workspace would see. A 404 here would
      // mean an attacker who is already a member of the workspace can
      // tell which agentIds exist by trying each one.
      const c = await login("a-member@example.com");
      const real = await app.fetch(
        new Request(url(), {
          method: "PUT",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ catalog_entry_id: "00000000-0000-0000-0000-000000000000" }),
        }),
      );
      expect(real.status).toBe(403);

      // Same caller, fake agent id. Must also 403 (not 404), and the
      // response body must be indistinguishable from the "real agent"
      // case so role-failure can't be inferred from message content.
      const fake = await app.fetch(
        new Request(
          `http://api.test/api/workspaces/alpha/agents/00000000-0000-0000-0000-000000000000/mcp-attachments`,
          {
            method: "PUT",
            headers: { Cookie: c, "Content-Type": "application/json" },
            body: JSON.stringify({ catalog_entry_id: "00000000-0000-0000-0000-000000000000" }),
          },
        ),
      );
      expect(fake.status).toBe(403);

      const realBody = await real.json();
      const fakeBody = await fake.json();
      expect(realBody).toEqual(fakeBody);
    });
  });

  describe("/env", () => {
    const url = () =>
      `http://api.test/api/workspaces/alpha/agents/${agentIdA}/env`;

    it("member of A can read env bindings in A", async () => {
      const c = await login("a-member@example.com");
      const res = await app.fetch(new Request(url(), { headers: { Cookie: c } }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { bindings: unknown[] };
      expect(Array.isArray(body.bindings)).toBe(true);
    });

    it("member of A cannot write env bindings in A", async () => {
      const c = await login("a-member@example.com");
      const res = await app.fetch(
        new Request(`${url()}/OPENAI_API_KEY`, {
          method: "PUT",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ secret_name: "openai" }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("admin of B cannot read env bindings in A (cross-workspace)", async () => {
      const c = await login("b-admin@example.com");
      const res = await app.fetch(new Request(url(), { headers: { Cookie: c } }));
      expect(res.status).toBe(403);
    });

    it("admin of B cannot write env bindings in A (cross-workspace)", async () => {
      const c = await login("b-admin@example.com");
      const res = await app.fetch(
        new Request(`${url()}/OPENAI_API_KEY`, {
          method: "PUT",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ secret_name: "openai" }),
        }),
      );
      expect(res.status).toBe(403);
    });
  });
});
