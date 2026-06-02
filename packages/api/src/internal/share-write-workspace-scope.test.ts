/**
 * Pins the cross-session share-update behaviour on the internal
 *   POST /api/internal/sessions/:sessionId/shares
 * route. The sidecar forwards every `share` MCP call here. Until this
 * fix the route required the share_id's existing owner-session to be
 * in the caller session's resume-chain — which meant "pause then come
 * back" worked only if the user clicked Resume (creating a chain) and
 * never if they spawned a fresh session that wanted to keep iterating
 * on a workspace artifact. The cross-tenant guard is still in place;
 * we just relax cross-session to cross-workspace.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceId, WorkspaceSlug, UserId } from "@x1agent/kernel";
import { InMemoryAgentRepository } from "@x1agent/domain-agents";
import {
  InMemorySessionRepository,
  InMemorySessionEventRepository,
} from "@x1agent/domain-sessions";
import { InMemoryPermissionGrantRepository } from "@x1agent/domain-permissions";
import { createInternalRoutes } from "./routes.js";

const TOKEN = "test-internal-token";

const WS_A = WorkspaceId("019da258-0000-7efa-98a1-aaaaaaaaaaaa");
const WS_B = WorkspaceId("019da258-0000-7efa-98a1-bbbbbbbbbbbb");

const SHARE_ID_OWNED_BY_A = "019d0000-7000-7000-7000-000000abcdef";
const OWNER_SESSION_A_SID = "019da258-7000-7000-7000-aaaaaaaaaaaa";
const CALLER_SESSION_SAME_WS_A_SID = "019da258-7000-7000-7000-cccccccccccc";
const CALLER_SESSION_OTHER_WS_B_SID = "019da258-7000-7000-7000-ddddddddddd1";

async function setup() {
  const events = new InMemorySessionEventRepository();
  const grants = new InMemoryPermissionGrantRepository();
  const agents = new InMemoryAgentRepository();
  const sessions = new InMemorySessionRepository();

  const agentA = await agents.create({
    workspaceId: WS_A,
    slug: WorkspaceSlug("agent-a"),
    name: "A",
    runtimeType: "claude_code" as never,
    kind: "worker" as never,
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: null,
  });
  const agentB = await agents.create({
    workspaceId: WS_B,
    slug: WorkspaceSlug("agent-b"),
    name: "B",
    runtimeType: "claude_code" as never,
    kind: "worker" as never,
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: null,
  });

  const t0 = Date.now();
  const ownerSession = await sessions.create({
    agentId: agentA.id,
    triggeredBy: "user",
    triggeredByUserId: UserId("019da258-7000-7000-7000-000000000001"),
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: new Date(t0),
  });
  const sameWsCaller = await sessions.create({
    agentId: agentA.id,
    triggeredBy: "user",
    triggeredByUserId: UserId("019da258-7000-7000-7000-000000000001"),
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: new Date(t0 + 1_000),
  });
  const otherWsCaller = await sessions.create({
    agentId: agentB.id,
    triggeredBy: "user",
    triggeredByUserId: UserId("019da258-7000-7000-7000-000000000001"),
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: new Date(t0 + 2_000),
  });

  // FakeSql: handle ONLY the share-id → owner-session lookup the
  // route makes. Anything else throws so a future query addition
  // forces an explicit test update.
  const fakeSql = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const query = strings.join("?");
    if (
      query.includes("session_events") &&
      query.includes("agent.share") &&
      query.includes("share_id")
    ) {
      const wantedShareId = String(values[0] ?? "");
      if (wantedShareId === SHARE_ID_OWNED_BY_A) {
        return Promise.resolve([{ session_id: ownerSession.id }]);
      }
      return Promise.resolve([]);
    }
    throw new Error(`fake sql: unexpected query: ${query}`);
  }) as never;

  const internal = createInternalRoutes({
    events,
    sessions,
    agents,
    grants,
    githubClient: null,
    internalToken: TOKEN,
    sql: fakeSql,
  });

  const app = new Hono();
  app.route("/api/internal", internal);

  // Per-test shares dir so writeShareFiles doesn't touch /tmp randomly.
  const sharesRoot = mkdtempSync(join(tmpdir(), "x1-share-write-test-"));
  const prevSharesDir = process.env.X1_SHARES_DIR;
  process.env.X1_SHARES_DIR = sharesRoot;

  return {
    app,
    ownerSession,
    sameWsCaller,
    otherWsCaller,
    cleanup: () => {
      process.env.X1_SHARES_DIR = prevSharesDir;
      rmSync(sharesRoot, { recursive: true, force: true });
    },
  };
}

async function postShare(
  app: Hono,
  sessionId: string,
  shareId: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://api.test/api/internal/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: {
        "X-Internal-Token": TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        share_id: shareId,
        files: [
          {
            path: "index.html",
            content: Buffer.from("<p>updated</p>").toString("base64"),
          },
        ],
      }),
    }),
  );
}

describe("internal POST /sessions/:sessionId/shares — share_id workspace scope", () => {
  it("accepts an update to a share whose owner-session is in the caller's workspace", async () => {
    const h = await setup();
    try {
      const res = await postShare(
        h.app,
        h.sameWsCaller.id,
        SHARE_ID_OWNED_BY_A,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("rejects an update to a share whose owner-session is in a different workspace", async () => {
    const h = await setup();
    try {
      const res = await postShare(
        h.app,
        h.otherWsCaller.id,
        SHARE_ID_OWNED_BY_A,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("share_id_owned_by_other_workspace");
    } finally {
      h.cleanup();
    }
  });

  it("accepts a brand-new share_id with no prior owner anywhere", async () => {
    const h = await setup();
    try {
      const res = await postShare(
        h.app,
        h.sameWsCaller.id,
        "019d0000-7000-7000-7000-fffffffffff0",
      );
      expect(res.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });
});
