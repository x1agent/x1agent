import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_auth_composition_test";

let sqlClient: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let routes: ReturnType<typeof compose>["authRoutes"];

beforeAll(async () => {
  const db = await freshTestDb(TEST_DB);
  sqlClient = db.sql;
  process.env.DATABASE_URL = db.url;

  // Seed one workspace + test user + membership.
  const [ws] = await sqlClient<{ id: string }[]>`
    INSERT INTO workspaces (slug, name) VALUES ('default', 'Default')
    RETURNING id
  `;
  const [user] = await sqlClient<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice')
    RETURNING id
  `;
  await sqlClient`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${ws!.id}, ${user!.id}, 'owner')
  `;

  const { authRoutes } = compose({
    sql: sqlClient,
    jwtSecret: "integration-test-secret",
    googleClientId: "placeholder-client-id",
    googleClientSecret: "placeholder-secret",
    appUrl: "http://app.test",
    apiUrl: "http://api.test",
    allowedDomains: [],
    platformAdmins: [],
    authBypass: true,
    testUserEmail: "alice@example.com",
    platformName: "x1agent",
  });
  routes = authRoutes;
});

afterAll(async () => {
  await sqlClient.end();
  await dropTestDb(TEST_DB);
});

function sessionCookie(headers: Headers): string | null {
  const raw = headers.get("set-cookie");
  if (!raw) return null;
  const m = raw.match(/x1_session=([^;]+)/);
  return m ? m[1]! : null;
}

describe("composed auth routes", () => {
  it("GET /config reports the active provider and bypass flag", async () => {
    const res = await routes.fetch(new Request("http://api.test/config"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      auth_bypass: boolean;
    };
    expect(body.provider).toBe("google");
    expect(body.auth_bypass).toBe(true);
  });

  it("GET /me returns 401 without a cookie", async () => {
    const res = await routes.fetch(new Request("http://api.test/me"));
    expect(res.status).toBe(401);
  });

  it("GET /bypass signs a session and redirects", async () => {
    const res = await routes.fetch(new Request("http://api.test/bypass"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://app.test/workspaces/default",
    );
    expect(sessionCookie(res.headers)).toBeTruthy();
  });

  it("GET /bypass + GET /me round-trips the same identity", async () => {
    const login = await routes.fetch(new Request("http://api.test/bypass"));
    const cookie = sessionCookie(login.headers)!;
    const me = await routes.fetch(
      new Request("http://api.test/me", {
        headers: { Cookie: `x1_session=${cookie}` },
      }),
    );
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      user: { email: string };
      memberships: { slug: string; role: string }[];
    };
    expect(body.user.email).toBe("alice@example.com");
    expect(body.memberships[0]!.slug).toBe("default");
    expect(body.memberships[0]!.role).toBe("owner");
  });

  it("GET /google issues a redirect to accounts.google.com", async () => {
    const res = await routes.fetch(new Request("http://api.test/google"));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toStartWith("https://accounts.google.com/o/oauth2/v2/auth");
  });
});
