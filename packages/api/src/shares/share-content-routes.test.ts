import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
  DomainError,
  type Email,
} from "@x1agent/kernel";
import { AgentId, type Agent } from "@x1agent/domain-agents";
import {
  SessionId,
  SessionShareId,
  type Session,
  type SessionShare,
  type SessionEvent,
} from "@x1agent/domain-sessions";
import { writeShareFiles } from "./storage.js";
import { createWorkspaceShareRoutes } from "./routes.js";

/**
 * PRD 0006, Slice A — regression for the new
 *   GET /api/workspaces/:slug/sessions/:sessionId/shares/:shareId/content
 * route. The agent's `read_share` MCP tool reads its own past shares
 * through this path so a resumed session can recover its previous
 * output even after `/workspace` was wiped.
 *
 * Auth model under test:
 *   - 200 when the share was emitted by the URL :sessionId
 *   - 403 when the share belongs to another session (sql wired)
 *   - 404 when the share id doesn't exist anywhere
 *   - 404 when the session isn't visible to the actor
 */

class FakeSessions {
  rows = new Map<string, Session>();
  add(s: Session) {
    this.rows.set(s.id, s);
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
}

class FakeAgents {
  rows = new Map<string, Agent>();
  add(a: Agent) {
    this.rows.set(a.id, a);
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
}

class FakeEvents {
  bySession = new Map<string, SessionEvent[]>();
  add(sessionId: string, ev: SessionEvent) {
    const arr = this.bySession.get(sessionId) ?? [];
    arr.push(ev);
    this.bySession.set(sessionId, arr);
  }
  async listBySession(sessionId: string) {
    return this.bySession.get(sessionId) ?? [];
  }
}

class FakeShares {
  rows: SessionShare[] = [];
  add(sessionId: string, userId: string) {
    this.rows.push({
      id: SessionShareId(`share-${this.rows.length + 1}`),
      sessionId: sessionId as never,
      userId: userId as never,
      role: "viewer",
      sharedBy: "" as never,
      createdAt: new Date(),
    });
  }
  async findForUser(sessionId: string, userId: string) {
    return (
      this.rows.find(
        (r) => r.sessionId === sessionId && r.userId === userId,
      ) ?? null
    );
  }
  async upsert() {
    throw new Error("not used");
  }
  async remove() {}
  async removeForUser() {}
  async listForSession() {
    return [];
  }
  async listForUser() {
    return [];
  }
}

class AdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("not admin");
  }
}

class AdminGuard {
  admins = new Set<string>();
  setAdmin(userId: string, workspaceId: string) {
    this.admins.add(`${userId}:${workspaceId}`);
  }
  async assertAdmin(userId: string, workspaceId: string) {
    if (!this.admins.has(`${userId}:${workspaceId}`))
      throw new AdminDeniedError();
  }
}

/**
 * Tiny tagged-template SQL shim. The route only fires one query —
 * `SELECT session_id FROM session_events WHERE type='agent.share' AND
 * payload->>'share_id' = $1 LIMIT 1`. The shim plays back any
 * `agent.share` event we registered, no real Postgres.
 */
function makeFakeSql(events: FakeEvents) {
  type Row = { session_id: string };
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (!sql.includes("session_events") || !sql.includes("share_id")) {
      throw new Error(`fake sql: unexpected query: ${sql}`);
    }
    const wanted = values.find((v) => typeof v === "string") as string;
    const matches: Row[] = [];
    for (const [sessionId, evs] of events.bySession.entries()) {
      for (const ev of evs) {
        if (ev.type !== "agent.share") continue;
        const payload =
          typeof ev.payload === "string"
            ? (JSON.parse(ev.payload) as Record<string, unknown>)
            : (ev.payload as Record<string, unknown>);
        if (payload?.share_id === wanted) {
          matches.push({ session_id: sessionId });
        }
      }
    }
    return Promise.resolve(matches);
  };
}

const WS_A = WorkspaceId("00000000-0000-7000-8000-0000000000a1");
const WS_B = WorkspaceId("00000000-0000-7000-8000-0000000000b1");
const SLUG_A = WorkspaceSlug("ws-a");
const SLUG_B = WorkspaceSlug("ws-b");

const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const BOB = UserId("00000000-0000-7000-8000-00000000b0b0");
const CAROL = UserId("00000000-0000-7000-8000-00000000ca40");

const AGENT_A = AgentId("00000000-0000-7000-8000-0000000000a0");
const SESSION_A = SessionId("00000000-0000-7000-8000-000000000001"); // owned by Alice
const SESSION_B = SessionId("00000000-0000-7000-8000-000000000002"); // owned by Bob — Alice is sharee

const SHARE_A = "share-a-aaaa";
const SHARE_B = "share-b-bbbb";

function makeAgent(id: AgentId, workspaceId: WorkspaceId): Agent {
  return {
    id,
    workspaceId,
    slug: "agent",
    name: "Agent",
    runtimeType: "claude_code",
    kind: "worker",
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    isActive: true,
    imageId: null,
    model: null,
    ownerUserId: ALICE,
    visibility: "workspace",
    createdBy: ALICE,
    scheduledRunAsUserId: ALICE,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSchedulerTickAt: null,
  } as unknown as Agent;
}

function makeSession(
  id: SessionId,
  agentId: AgentId,
  ownerId: ReturnType<typeof UserId>,
): Session {
  return {
    id,
    agentId,
    triggeredBy: "user",
    triggeredByUserId: ownerId,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: new Date(),
    status: "running",
    completedAt: null,
    errorMessage: null,
    createdAt: new Date(),
    summary: null,
    summaryUpdatedAt: null,
    summaryEventSeq: null,
  } as Session;
}

let sessions: FakeSessions;
let agents: FakeAgents;
let events: FakeEvents;
let shares: FakeShares;
let adminGuard: AdminGuard;
let actor: { userId: ReturnType<typeof UserId>; email: Email };
let sharesRoot: string;
let prevSharesDir: string | undefined;

function build(opts: { withSql?: boolean } = {}) {
  const routes = createWorkspaceShareRoutes({
    sessions: sessions as never,
    events: events as never,
    agents: agents as never,
    adminGuard: adminGuard as never,
    shares: shares as never,
    resolveWorkspace: async (slug) => {
      if (slug === SLUG_A) return WS_A;
      if (slug === SLUG_B) return WS_B;
      return null;
    },
    requireAuth: async (_c, next) => {
      await next();
    },
    getActor: () => actor,
    sql: opts.withSql ? (makeFakeSql(events) as never) : undefined,
  });
  const root = new Hono();
  root.route(
    "/api/workspaces/:slug/sessions/:sessionId/shares",
    routes,
  );
  return root;
}

beforeEach(() => {
  sessions = new FakeSessions();
  agents = new FakeAgents();
  events = new FakeEvents();
  shares = new FakeShares();
  adminGuard = new AdminGuard();

  agents.add(makeAgent(AGENT_A, WS_A));
  sessions.add(makeSession(SESSION_A, AGENT_A, ALICE));
  sessions.add(makeSession(SESSION_B, AGENT_A, BOB));

  events.add(SESSION_A, {
    id: "e1" as never,
    sessionId: SESSION_A as never,
    seq: 1,
    type: "agent.share",
    payload: { share_id: SHARE_A, title: "Alice's deck" },
    timestamp: new Date(),
  } as unknown as SessionEvent);
  events.add(SESSION_B, {
    id: "e2" as never,
    sessionId: SESSION_B as never,
    seq: 1,
    type: "agent.share",
    payload: { share_id: SHARE_B, title: "Bob's deck" },
    timestamp: new Date(),
  } as unknown as SessionEvent);

  shares.add(SESSION_B, ALICE); // Alice is a sharee on Bob's session.
  adminGuard.setAdmin(CAROL, WS_A);

  // Per-test temp dir for share content. The internal write path
  // writes under X1_SHARES_DIR/sessions/{id}/shares/{share_id}/.
  sharesRoot = mkdtempSync(join(tmpdir(), "x1-share-content-test-"));
  prevSharesDir = process.env.X1_SHARES_DIR;
  process.env.X1_SHARES_DIR = sharesRoot;
});

afterEach(() => {
  if (prevSharesDir === undefined) delete process.env.X1_SHARES_DIR;
  else process.env.X1_SHARES_DIR = prevSharesDir;
  rmSync(sharesRoot, { recursive: true, force: true });
});

describe("GET /:shareId/content — Slice A", () => {
  it("returns the bytes of a share written in this session", async () => {
    const original = "# hello\n\nthis is a markdown share.";
    writeShareFiles(SESSION_A, SHARE_A, [
      {
        path: "index.html",
        content: Buffer.from(original, "utf8").toString("base64"),
      },
    ]);

    actor = { userId: ALICE, email: "a@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_A}/content`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      share_id: string;
      mime_type: string;
      size: number;
      content_b64: string;
      path?: string;
    };
    expect(body.share_id).toBe(SHARE_A);
    expect(body.mime_type).toBe("text/html");
    expect(body.size).toBe(original.length);
    expect(body.path).toBeUndefined();
    expect(Buffer.from(body.content_b64, "base64").toString("utf8")).toBe(
      original,
    );
  });

  it("returns 403 when reading a share owned by a different session (sql wired)", async () => {
    // Alice has visibility to SESSION_A (owner) but tries to read
    // SHARE_B which lives in SESSION_B's history. The path 'belongs
    // to this session' check rejects it as 403 even though Alice can
    // see Bob's session as a sharee — Slice A is narrower than the
    // visibility check.
    writeShareFiles(SESSION_B, SHARE_B, [
      { path: "index.html", content: Buffer.from("bob", "utf8").toString("base64") },
    ]);
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const app = build({ withSql: true });
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_B}/content`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cross_session_read_forbidden");
  });

  it("returns 404 for a share_id that doesn't exist anywhere", async () => {
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const app = build({ withSql: true });
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/does-not-exist/content`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("share_not_found");
  });

  it("returns 404 when the actor can't see the session", async () => {
    // Bob owns SESSION_B and SHARE_B; he's not a member visible to
    // anyone else here. Pretend Carol (admin in WS_A) is asking for
    // a share id that doesn't even exist on a session id she also
    // can't reach. The session lookup short-circuits to 404 before
    // we ever touch the share index — matches the cross-tenant
    // pattern the existing list route uses.
    const unknownSession = SessionId("00000000-0000-7000-8000-0000000000ff");
    actor = { userId: BOB, email: "b@x.com" as Email };
    const app = build({ withSql: true });
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${unknownSession}/shares/${SHARE_A}/content`,
    );
    expect(res.status).toBe(404);
  });

  it("addresses a sub-path inside a multi-file share via ?path=", async () => {
    writeShareFiles(SESSION_A, SHARE_A, [
      { path: "index.html", content: Buffer.from("home", "utf8").toString("base64") },
      {
        path: "assets/main.css",
        content: Buffer.from("body{color:red}", "utf8").toString("base64"),
      },
    ]);
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_A}/content?path=${encodeURIComponent("assets/main.css")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mime_type: string;
      content_b64: string;
      path?: string;
    };
    expect(body.mime_type).toBe("text/css");
    expect(body.path).toBe("assets/main.css");
    expect(Buffer.from(body.content_b64, "base64").toString("utf8")).toBe(
      "body{color:red}",
    );
  });

  it("round-trips a ≥1 MB binary share without truncation", async () => {
    // Random-looking binary so a naive utf8 path would mangle it.
    const big = Buffer.alloc(1024 * 1024 + 17);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) & 0xff;
    writeShareFiles(SESSION_A, SHARE_A, [
      { path: "blob.bin", content: big.toString("base64") },
    ]);
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const app = build();
    const res = await app.request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_A}/content?path=blob.bin`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      size: number;
      content_b64: string;
    };
    expect(body.size).toBe(big.length);
    const decoded = Buffer.from(body.content_b64, "base64");
    expect(decoded.length).toBe(big.length);
    expect(decoded.equals(big)).toBe(true);
  });
});
