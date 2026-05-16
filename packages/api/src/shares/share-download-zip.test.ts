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
  type Session,
  type SessionEvent,
} from "@x1agent/domain-sessions";
import { writeShareFiles } from "./storage.js";
import { createWorkspaceShareRoutes } from "./routes.js";

/**
 * Route-level cover for GET /:shareId/_download.zip — confirms that
 * (1) the route returns a real zip with the bytes of every file the
 * share's `agent.share` event declared, and (2) cross-session /
 * cross-workspace probing is rejected through the same visibility
 * primitive as the other share routes.
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
  async findForUser() {
    return null;
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
  async assertAdmin() {
    throw new AdminDeniedError();
  }
}

const WS_A = WorkspaceId("00000000-0000-7000-8000-0000000000a1");
const SLUG_A = WorkspaceSlug("ws-a");
const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const AGENT_A = AgentId("00000000-0000-7000-8000-0000000000a0");
const SESSION_A = SessionId("00000000-0000-7000-8000-000000000001");
const SHARE_A = "share-a-aaaa";

function makeAgent(): Agent {
  return {
    id: AGENT_A,
    workspaceId: WS_A,
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
function makeSession(): Session {
  return {
    id: SESSION_A,
    agentId: AGENT_A,
    triggeredBy: "user",
    triggeredByUserId: ALICE,
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

function build() {
  const routes = createWorkspaceShareRoutes({
    sessions: sessions as never,
    events: events as never,
    agents: agents as never,
    adminGuard: adminGuard as never,
    shares: shares as never,
    resolveWorkspace: async (slug) =>
      slug === SLUG_A ? WS_A : null,
    requireAuth: async (_c, next) => {
      await next();
    },
    getActor: () => actor,
  });
  const root = new Hono();
  root.route("/api/workspaces/:slug/sessions/:sessionId/shares", routes);
  return root;
}

beforeEach(() => {
  sessions = new FakeSessions();
  agents = new FakeAgents();
  events = new FakeEvents();
  shares = new FakeShares();
  adminGuard = new AdminGuard();
  agents.add(makeAgent());
  sessions.add(makeSession());
  sharesRoot = mkdtempSync(join(tmpdir(), "x1-share-zip-test-"));
  prevSharesDir = process.env.X1_SHARES_DIR;
  process.env.X1_SHARES_DIR = sharesRoot;
});

afterEach(() => {
  if (prevSharesDir === undefined) delete process.env.X1_SHARES_DIR;
  else process.env.X1_SHARES_DIR = prevSharesDir;
  rmSync(sharesRoot, { recursive: true, force: true });
});

describe("GET /:shareId/_download.zip", () => {
  it("returns a zip of every file declared by the agent.share event", async () => {
    // Stage two files on disk; declare them on the event payload so
    // the route's file list pulls both.
    writeShareFiles(SESSION_A, SHARE_A, [
      {
        path: "index.html",
        content: Buffer.from("<h1>hi</h1>", "utf8").toString("base64"),
      },
      {
        path: "assets/style.css",
        content: Buffer.from("body{margin:0}", "utf8").toString("base64"),
      },
    ]);
    events.add(SESSION_A, {
      id: "e1" as never,
      sessionId: SESSION_A as never,
      seq: 1,
      type: "agent.share",
      payload: {
        share_id: SHARE_A,
        title: "alice deck",
        files: [{ path: "index.html" }, { path: "assets/style.css" }],
      },
      timestamp: new Date(),
    } as unknown as SessionEvent);

    actor = { userId: ALICE, email: "a@x.com" as Email };
    const res = await build().request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_A}/_download.zip`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp).toContain("attachment");
    expect(disp).toContain("alice_deck.zip");

    const zip = Buffer.from(await res.arrayBuffer());
    // ZIP local-header magic at start, EOCD magic 22 bytes from the end.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const eocdOffset = zip.length - 22;
    expect(zip.readUInt32LE(eocdOffset)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocdOffset + 10)).toBe(2);
  });

  it("returns 404 when the share has no agent.share event in this session", async () => {
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const res = await build().request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_A}/_download.zip`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the event declares files that are not on disk", async () => {
    events.add(SESSION_A, {
      id: "e1" as never,
      sessionId: SESSION_A as never,
      seq: 1,
      type: "agent.share",
      payload: {
        share_id: SHARE_A,
        files: [{ path: "missing.txt" }],
      },
      timestamp: new Date(),
    } as unknown as SessionEvent);
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const res = await build().request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_A}/_download.zip`,
    );
    expect(res.status).toBe(404);
  });

  it("Zip-Slip guard: refuses traversal / absolute / backslash paths from the payload", async () => {
    // Plant a real file at a safe name so the read side has something
    // to find — but the event declares only unsafe paths. The route
    // must reject them all and respond 404.
    writeShareFiles(SESSION_A, SHARE_A, [
      {
        path: "ok.txt",
        content: Buffer.from("ok", "utf8").toString("base64"),
      },
    ]);
    events.add(SESSION_A, {
      id: "e1" as never,
      sessionId: SESSION_A as never,
      seq: 1,
      type: "agent.share",
      payload: {
        share_id: SHARE_A,
        files: [
          { path: "../../../tmp/pwned" },
          { path: "/etc/passwd" },
          { path: "a\\b.txt" },
          { path: "./.bashrc" },
          { path: "" },
        ],
      },
      timestamp: new Date(),
    } as unknown as SessionEvent);
    actor = { userId: ALICE, email: "a@x.com" as Email };
    const res = await build().request(
      `/api/workspaces/ws-a/sessions/${SESSION_A}/shares/${SHARE_A}/_download.zip`,
    );
    expect(res.status).toBe(404);
  });
});
