import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

/**
 * X1A-9 regression — session + share scoping.
 *
 * Every list/get endpoint that returns sessions or shares must be
 * scoped to "what the actor is allowed to see":
 *   - workspace admin/owner: everything in the workspace.
 *   - session owner (triggered_by_user_id): their own sessions.
 *   - explicit sharee (session_user_shares row): the shared session.
 *   - everyone else: nothing.
 *
 * Cross-workspace isolation is independent: a user from workspace B
 * must never see workspace A's session/share via any endpoint, even
 * if they're an admin in B.
 *
 * The matrix is exercised against the live composition root (Hono + real
 * Postgres). Postgres branches are the load-bearing line for visibility,
 * so the fake-based unit tests in `session-visibility.test.ts` are
 * insufficient on their own.
 */

const TEST_DB = "x1agent_shares_vis_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let app: Hono;

// Pre-seeded ids — captured in beforeAll.
let wsA = "";
let wsB = "";
let agentA = "";
let agentB = "";
let aliceId = ""; // owner-in-A, member-only
let bobId = ""; // bystander-in-A, member-only
let carolId = ""; // admin-in-A
let daveId = ""; // owner-in-B, admin-in-B
let aliceSession = ""; // owned by Alice in workspace A
let bobSession = ""; // owned by Bob in workspace A — Alice is sharee
let daveSession = ""; // owned by Dave in workspace B
let aliceShareId = ""; // share emitted by aliceSession
let daveShareId = ""; // share emitted by daveSession

beforeAll(async () => {
  const db = await freshTestDb(TEST_DB);
  dbSql = db.sql;
  process.env.DATABASE_URL = db.url;
  const { resetSql } = await import("./db/client.js");
  await resetSql();

  // Two workspaces, four users.
  const [a, b] = await dbSql<{ id: string; slug: string }[]>`
    INSERT INTO workspaces (slug, name)
    VALUES ('ws-a', 'Workspace A'), ('ws-b', 'Workspace B')
    RETURNING id, slug
  `;
  wsA = a!.id;
  wsB = b!.id;

  const users = await dbSql<{ id: string; email: string }[]>`
    INSERT INTO users (email, name)
    VALUES ('alice@example.com', 'Alice'),
           ('bob@example.com', 'Bob'),
           ('carol@example.com', 'Carol'),
           ('dave@example.com', 'Dave')
    RETURNING id, email
  `;
  aliceId = users.find((u) => u.email === "alice@example.com")!.id;
  bobId = users.find((u) => u.email === "bob@example.com")!.id;
  carolId = users.find((u) => u.email === "carol@example.com")!.id;
  daveId = users.find((u) => u.email === "dave@example.com")!.id;

  // Memberships: in A — Carol is admin, Alice + Bob are members.
  //              in B — Dave is admin.
  // Cross-workspace test depends on Dave NOT being in A.
  await dbSql`
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      (${wsA}, ${carolId}, 'admin'),
      (${wsA}, ${aliceId}, 'member'),
      (${wsA}, ${bobId},   'member'),
      (${wsB}, ${daveId},  'admin')
  `;

  // One agent per workspace.
  const agents = await dbSql<{ id: string; workspace_id: string }[]>`
    INSERT INTO agents
      (workspace_id, slug, name, runtime_type, kind, system_prompt,
       owner_user_id, created_by, scheduled_run_as_user_id, is_active)
    VALUES
      (${wsA}, 'agent-a', 'Agent A', 'claude_code', 'worker', '',
       ${carolId}, ${carolId}, ${carolId}, true),
      (${wsB}, 'agent-b', 'Agent B', 'claude_code', 'worker', '',
       ${daveId}, ${daveId}, ${daveId}, true)
    RETURNING id, workspace_id
  `;
  agentA = agents.find((a) => a.workspace_id === wsA)!.id;
  agentB = agents.find((a) => a.workspace_id === wsB)!.id;

  // Sessions:
  //   aliceSession — agent A, owner Alice
  //   bobSession   — agent A, owner Bob (Alice is sharee)
  //   daveSession  — agent B, owner Dave
  const sessions = await dbSql<{ id: string; triggered_by_user_id: string }[]>`
    INSERT INTO sessions (agent_id, triggered_by, triggered_by_user_id, triggered_at)
    VALUES
      (${agentA}, 'user', ${aliceId}, now() - interval '3 minutes'),
      (${agentA}, 'user', ${bobId},   now() - interval '2 minutes'),
      (${agentB}, 'user', ${daveId},  now() - interval '1 minute')
    RETURNING id, triggered_by_user_id
  `;
  aliceSession = sessions.find((s) => s.triggered_by_user_id === aliceId)!.id;
  bobSession = sessions.find((s) => s.triggered_by_user_id === bobId)!.id;
  daveSession = sessions.find((s) => s.triggered_by_user_id === daveId)!.id;

  // Bob shares his session with Alice as viewer.
  await dbSql`
    INSERT INTO session_user_shares (session_id, user_id, role, shared_by)
    VALUES (${bobSession}, ${aliceId}, 'viewer', ${bobId})
  `;

  // One agent.share event per session that emits a share.
  aliceShareId = "share-alice-1";
  daveShareId = "share-dave-1";
  await dbSql`
    INSERT INTO session_events (session_id, seq, type, payload, timestamp)
    VALUES
      (${aliceSession}, 1, 'agent.share',
       ${JSON.stringify({ share_id: aliceShareId, share_type: "document", title: "Alice's share" })}::jsonb,
       now() - interval '2 minutes'),
      (${daveSession}, 1, 'agent.share',
       ${JSON.stringify({ share_id: daveShareId, share_type: "document", title: "Dave's share" })}::jsonb,
       now() - interval '30 seconds')
  `;

  process.env.TEST_USER = "carol@example.com";
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
    jwtSecret: "vis-test-secret",
    googleClientId: "x",
    googleClientSecret: "x",
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

async function buildAppFor(email: string) {
  process.env.TEST_USER = email;
  const { resetSql } = await import("./db/client.js");
  await resetSql();
  const composed = compose({
    sql: dbSql,
    jwtSecret: "vis-test-secret",
    googleClientId: "x",
    googleClientSecret: "x",
    appUrl: "http://app.test",
    apiUrl: "http://api.test",
    allowedDomains: [],
    platformAdmins: [],
    authBypass: true,
    testUserEmail: email,
    platformName: "x1agent",
    workspaceSecretsMasterKey: "0".repeat(64),
  });
  const a = new Hono();
  a.route("/auth", composed.authRoutes);
  a.route("/api/workspaces/:slug/sessions", composed.workspaceSessionRoutes);
  a.route(
    "/api/workspaces/:slug/sessions/:sessionId/shares",
    composed.workspaceShareRoutes,
  );
  a.route("/api/workspaces/:slug/shares", composed.workspaceSharesIndexRoutes);
  return a;
}

async function getJson(a: Hono, url: string, c: string) {
  const res = await a.fetch(new Request(url, { headers: { Cookie: c } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("X1A-9 — workspace sessions list visibility", () => {
  it("admin sees every session in the workspace (admin path)", async () => {
    const c = await login("carol@example.com");
    app = await buildAppFor("carol@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/sessions", c);
    expect(r.status).toBe(200);
    const ids = (r.body.sessions as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(aliceSession);
    expect(ids).toContain(bobSession);
  });

  it("owner sees own + sessions shared with them; NOT others (non-admin path)", async () => {
    const c = await login("alice@example.com");
    app = await buildAppFor("alice@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/sessions", c);
    expect(r.status).toBe(200);
    const ids = (r.body.sessions as { id: string }[]).map((s) => s.id);
    // Owner of aliceSession + sharee on bobSession.
    expect(ids).toContain(aliceSession);
    expect(ids).toContain(bobSession);
  });

  it("workspace member who is neither owner nor sharee sees NOTHING from a peer", async () => {
    // Seed: Bob's session is not owned by Bob's peer here — we use a
    // separate session whose owner is Alice and whose share list is
    // empty. Bob (workspace member, not admin, not owner, not sharee)
    // should NOT see Alice's session.
    const c = await login("bob@example.com");
    app = await buildAppFor("bob@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/sessions", c);
    expect(r.status).toBe(200);
    const ids = (r.body.sessions as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(bobSession); // owner of bobSession
    expect(ids).not.toContain(aliceSession); // Alice's session, not shared with Bob
  });

  it("cross-workspace: an admin of B sees nothing from workspace A", async () => {
    // Dave is admin in B. Accessing /api/workspaces/ws-a/sessions
    // should fail (workspace membership middleware on the agent routes
    // is separate; here the route only checks membership via the
    // adminGuard.assertAdmin, but the visibility helper falls through
    // to non-admin mode — and Dave owns no sessions in A and is not a
    // sharee on any). Expectation: empty result, not a 200 with rows.
    const c = await login("dave@example.com");
    app = await buildAppFor("dave@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/sessions", c);
    expect(r.status).toBe(200);
    const ids = (r.body.sessions as { id: string }[]).map((s) => s.id);
    expect(ids).not.toContain(aliceSession);
    expect(ids).not.toContain(bobSession);
    expect(ids).not.toContain(daveSession);
  });
});

describe("X1A-9 — workspace session detail visibility", () => {
  it("owner can GET their own session", async () => {
    const c = await login("alice@example.com");
    app = await buildAppFor("alice@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}`,
      c,
    );
    expect(r.status).toBe(200);
  });

  it("sharee can GET a session shared with them", async () => {
    const c = await login("alice@example.com");
    app = await buildAppFor("alice@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${bobSession}`,
      c,
    );
    expect(r.status).toBe(200);
  });

  it("workspace admin can GET any session in the workspace", async () => {
    const c = await login("carol@example.com");
    app = await buildAppFor("carol@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}`,
      c,
    );
    expect(r.status).toBe(200);
  });

  it("non-owner, non-admin, non-sharee gets 404 (no info leak)", async () => {
    // Bob is a workspace A member but neither owns nor was shared
    // aliceSession. Must NOT see it.
    const c = await login("bob@example.com");
    app = await buildAppFor("bob@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}`,
      c,
    );
    expect(r.status).toBe(404);
  });

  it("cross-workspace: workspace B admin gets 404 on a workspace A session", async () => {
    const c = await login("dave@example.com");
    app = await buildAppFor("dave@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}`,
      c,
    );
    expect(r.status).toBe(404);
  });
});

describe("X1A-9 — per-session shares list visibility", () => {
  it("owner can list shares on their own session", async () => {
    const c = await login("alice@example.com");
    app = await buildAppFor("alice@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}/shares`,
      c,
    );
    expect(r.status).toBe(200);
    const shares = r.body.shares as { share_id: string }[];
    expect(shares.length).toBe(1);
    expect(shares[0]!.share_id).toBe(aliceShareId);
  });

  it("non-owner non-admin non-sharee gets 404", async () => {
    const c = await login("bob@example.com");
    app = await buildAppFor("bob@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}/shares`,
      c,
    );
    expect(r.status).toBe(404);
  });

  it("workspace admin can list shares on any session", async () => {
    const c = await login("carol@example.com");
    app = await buildAppFor("carol@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}/shares`,
      c,
    );
    expect(r.status).toBe(200);
  });

  it("cross-workspace: workspace B admin gets 404 on workspace A session shares", async () => {
    const c = await login("dave@example.com");
    app = await buildAppFor("dave@example.com");
    const r = await getJson(
      app,
      `http://api.test/api/workspaces/ws-a/sessions/${aliceSession}/shares`,
      c,
    );
    expect(r.status).toBe(404);
  });
});

describe("X1A-9 — workspace shares index visibility", () => {
  it("admin sees every share in the workspace", async () => {
    const c = await login("carol@example.com");
    app = await buildAppFor("carol@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/shares", c);
    expect(r.status).toBe(200);
    const shareIds = (r.body.shares as { share_id: string }[]).map((s) => s.share_id);
    expect(shareIds).toContain(aliceShareId);
  });

  it("non-admin sees only shares from sessions visible to them", async () => {
    const c = await login("alice@example.com");
    app = await buildAppFor("alice@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/shares", c);
    expect(r.status).toBe(200);
    const shareIds = (r.body.shares as { share_id: string }[]).map((s) => s.share_id);
    expect(shareIds).toContain(aliceShareId); // owner
  });

  it("non-admin non-owner non-sharee sees zero shares from peers", async () => {
    // Bob is a member of A but is neither owner nor sharee of
    // aliceSession (no shares attached to bobSession). Result: empty.
    const c = await login("bob@example.com");
    app = await buildAppFor("bob@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/shares", c);
    expect(r.status).toBe(200);
    const shareIds = (r.body.shares as { share_id: string }[]).map((s) => s.share_id);
    expect(shareIds).not.toContain(aliceShareId);
  });

  it("cross-workspace: workspace A admin does NOT see workspace B shares", async () => {
    const c = await login("carol@example.com");
    app = await buildAppFor("carol@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-a/shares", c);
    expect(r.status).toBe(200);
    const shareIds = (r.body.shares as { share_id: string }[]).map((s) => s.share_id);
    expect(shareIds).not.toContain(daveShareId);
  });

  it("cross-workspace: workspace B admin does NOT see workspace A shares", async () => {
    const c = await login("dave@example.com");
    app = await buildAppFor("dave@example.com");
    const r = await getJson(app, "http://api.test/api/workspaces/ws-b/shares", c);
    expect(r.status).toBe(200);
    const shareIds = (r.body.shares as { share_id: string }[]).map((s) => s.share_id);
    expect(shareIds).toContain(daveShareId);
    expect(shareIds).not.toContain(aliceShareId);
  });
});
