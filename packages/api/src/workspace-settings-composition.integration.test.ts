import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

// Regression suite for the workspace_settings JSONB persistence path.
// The original `updateSettings` used `settings || ${stringified}::jsonb`
// which postgres-js double-encoded — the `||` then ran between an
// object and a JSON-string and produced a JSONB ARRAY instead of
// merging. Read returned `[{}, "{...}"]`, the domain parser saw a
// non-object shape, fell back to default. UI showed "Saved" and then
// snapped back to "off". These tests prove that path is gone.

const TEST_DB = "x1agent_workspace_settings_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let app: Hono;

describe("workspace settings JSONB merge", () => {
  beforeAll(async () => {
    const db = await freshTestDb(TEST_DB);
    dbSql = db.sql;
    process.env.DATABASE_URL = db.url;
    const { resetSql } = await import("./db/client.js");
    await resetSql();

    const [ws] = await dbSql<{ id: string }[]>`
      INSERT INTO workspaces (slug, name) VALUES ('acme', 'Acme')
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
      workspaceSecretsMasterKey: "0".repeat(64),
    });

    app = new Hono();
    app.route("/auth", composed.authRoutes);
    // workspaceCreateRoutes is the same Hono app that hosts GET /:slug
    // and PATCH /:slug/settings — mounted at /api/workspaces.
    app.route("/api/workspaces", composed.workspaceCreateRoutes);
  }, 30_000);

  afterAll(async () => {
    if (dbSql) await dbSql.end();
    const { resetSql } = await import("./db/client.js");
    await resetSql();
    await dropTestDb(TEST_DB);
  }, 30_000);

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

  it("PATCH echoes the new value as a JSONB OBJECT (not array)", async () => {
    const c = await loginAsAdmin();
    const res = await app.fetch(
      new Request("http://api.test/api/workspaces/acme/settings", {
        method: "PATCH",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ oauthMcpsOnOrchestrators: "on" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: unknown };
    expect(body.settings).toEqual({
      oauthMcpsOnOrchestrators: "on",
      adminMcpEnabled: false,
    });
  });

  it("GET after PATCH returns the same value (no array stringification)", async () => {
    const c = await loginAsAdmin();
    await app.fetch(
      new Request("http://api.test/api/workspaces/acme/settings", {
        method: "PATCH",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ oauthMcpsOnOrchestrators: "on_attended" }),
      }),
    );
    const res = await app.fetch(
      new Request("http://api.test/api/workspaces/acme", {
        headers: { Cookie: c },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: unknown };
    expect(body.settings).toEqual({
      oauthMcpsOnOrchestrators: "on_attended",
      adminMcpEnabled: false,
    });
  });

  it("multiple PATCHes merge cleanly (no array growth)", async () => {
    const c = await loginAsAdmin();
    for (const mode of ["off", "on", "on_attended", "on", "off"] as const) {
      await app.fetch(
        new Request("http://api.test/api/workspaces/acme/settings", {
          method: "PATCH",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify({ oauthMcpsOnOrchestrators: mode }),
        }),
      );
    }
    // Read directly from the DB to confirm the row is a JSONB OBJECT,
    // not the bug's signature `[{}, "{...}", "{...}", ...]` array.
    const rows = await dbSql<{ settings: unknown }[]>`
      SELECT settings FROM workspaces WHERE slug = 'acme'
    `;
    expect(rows[0]).toBeDefined();
    expect(Array.isArray(rows[0]!.settings)).toBe(false);
    expect(typeof rows[0]!.settings).toBe("object");
    expect(rows[0]!.settings).toEqual({
      oauthMcpsOnOrchestrators: "off",
    });
  });

  it("concurrent patches to different keys cannot overwrite each other", async () => {
    const c = await loginAsAdmin();
    const request = (body: Record<string, unknown>) =>
      app.fetch(
        new Request("http://api.test/api/workspaces/acme/settings", {
          method: "PATCH",
          headers: { Cookie: c, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const [oauth, mcp] = await Promise.all([
      request({ oauthMcpsOnOrchestrators: "on_attended" }),
      request({ adminMcpEnabled: true }),
    ]);
    expect(oauth.status).toBe(200);
    expect(mcp.status).toBe(200);

    const rows = await dbSql<{ settings: unknown }[]>`
      SELECT settings FROM workspaces WHERE slug = 'acme'
    `;
    expect(rows[0]!.settings).toEqual({
      oauthMcpsOnOrchestrators: "on_attended",
      adminMcpEnabled: true,
    });
  });
});
