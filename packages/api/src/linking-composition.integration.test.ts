import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_linking_test";

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
  // Two users linked to the same person
  const [person] = await dbSql<{ id: string }[]>`
    INSERT INTO persons (display_name) VALUES ('Alice')
    RETURNING id
  `;
  const [home] = await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name, person_id)
    VALUES ('alice@example.com', 'Alice', ${person!.id})
    RETURNING id
  `;
  const [work] = await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name, person_id)
    VALUES ('alice@work.co', 'Alice (work)', ${person!.id})
    RETURNING id
  `;
  await dbSql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${ws!.id}, ${home!.id}, 'owner'),
           (${ws!.id}, ${work!.id}, 'member')
  `;

  process.env.TEST_USER = "alice@example.com";

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
    testUserEmail: "alice@example.com",
    platformName: "x1agent",
    workspaceSecretsMasterKey: "0".repeat(64),
  });
  app = new Hono();
  app.route("/auth", composed.authRoutes);
});

afterAll(async () => {
  if (dbSql) await dbSql.end();
  const { resetSql } = await import("./db/client.js");
  await resetSql();
  await dropTestDb(TEST_DB);
});

function getSessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/x1_session=([^;]+)/);
  if (!m) throw new Error("no session cookie");
  return `x1_session=${m[1]}`;
}

async function login(): Promise<string> {
  return getSessionCookie(
    await app.fetch(new Request("http://api.test/auth/bypass")),
  );
}

describe("account linking routes", () => {
  it("GET /auth/accounts returns both linked users with current flag", async () => {
    const c = await login();
    const res = await app.fetch(
      new Request("http://api.test/auth/accounts", {
        headers: { Cookie: c },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: { email: string; is_current: boolean }[];
    };
    const emails = body.accounts.map((a) => a.email).sort();
    expect(emails).toEqual(["alice@example.com", "alice@work.co"]);
    const current = body.accounts.find((a) => a.is_current);
    expect(current?.email).toBe("alice@example.com");
  });

  it("POST /auth/link/begin returns a Google authorize URL when authed", async () => {
    const c = await login();
    const res = await app.fetch(
      new Request("http://api.test/auth/link/begin", {
        method: "POST",
        headers: { Cookie: c },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorize_url: string };
    expect(body.authorize_url).toStartWith(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const url = new URL(body.authorize_url);
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("POST /auth/link/begin requires auth", async () => {
    const res = await app.fetch(
      new Request("http://api.test/auth/link/begin", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("POST /auth/switch_account rotates session to the target user", async () => {
    const c = await login();
    // discover the work user's id
    const accts = (await (
      await app.fetch(
        new Request("http://api.test/auth/accounts", {
          headers: { Cookie: c },
        }),
      )
    ).json()) as { accounts: { user_id: string; email: string }[] };
    const target = accts.accounts.find((a) => a.email === "alice@work.co")!;

    const res = await app.fetch(
      new Request("http://api.test/auth/switch_account", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: target.user_id }),
      }),
    );
    expect(res.status).toBe(200);
    const newCookie = getSessionCookie(res);

    // /me with the new cookie should show the target identity
    const me = await app.fetch(
      new Request("http://api.test/auth/me", {
        headers: { Cookie: newCookie },
      }),
    );
    const body = (await me.json()) as { user: { email: string } };
    expect(body.user.email).toBe("alice@work.co");
  });

  it("POST /auth/switch_account 403 when target is not linked to the caller", async () => {
    // Seed a stranger not linked to our person
    const [stranger] = await dbSql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES ('stranger@example.com', 'S')
      RETURNING id
    `;
    const c = await login();
    const res = await app.fetch(
      new Request("http://api.test/auth/switch_account", {
        method: "POST",
        headers: { Cookie: c, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: stranger!.id }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
