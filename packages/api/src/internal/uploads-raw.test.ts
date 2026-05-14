/**
 * t02/t05 P0 (X1A-96 follow-up): the agent container no longer holds
 * `API_INTERNAL_TOKEN`. Upload bytes are read through the sidecar's
 * `/uploads/read` credential proxy, which calls this api route on
 * behalf of the agent. The sidecar applies a defense-in-depth
 * workspace check on the upload's owning workspace; the api makes
 * that possible by surfacing the upload's workspace slug in the
 * `X-Upload-Workspace-Slug` response header.
 *
 * This test pins the response header + the existing user_id /
 * session_id ownership checks so a future refactor can't quietly
 * drop them.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { WorkspaceId, WorkspaceSlug, UserId } from "@x1agent/kernel";
import {
  InMemoryAgentRepository,
} from "@x1agent/domain-agents";
import {
  InMemorySessionRepository,
  InMemorySessionEventRepository,
} from "@x1agent/domain-sessions";
import { InMemoryPermissionGrantRepository } from "@x1agent/domain-permissions";
import {
  InMemoryUploadRepository,
  InMemoryUploadStorage,
  UploadId,
} from "@x1agent/domain-uploads";
import { createInternalRoutes } from "./routes.js";

const TOKEN = "test-internal-token";

interface Harness {
  app: Hono;
  uploads: InMemoryUploadRepository;
  storage: InMemoryUploadStorage;
  agents: InMemoryAgentRepository;
  sessions: InMemorySessionRepository;
  workspaceSlugForWorkspaceId: Map<string, string>;
}

async function setup(): Promise<Harness> {
  const events = new InMemorySessionEventRepository();
  const grants = new InMemoryPermissionGrantRepository();
  const agents = new InMemoryAgentRepository();
  const sessions = new InMemorySessionRepository();
  const uploads = new InMemoryUploadRepository();
  const storage = new InMemoryUploadStorage();
  const workspaceSlugForWorkspaceId = new Map<string, string>();

  // Mock the `cfg.sql` tagged-template. The route only does one
  // SELECT slug FROM workspaces WHERE id = $1 — match that shape by
  // looking up against the test's pre-populated workspace map.
  const fakeSql = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const query = strings.join("?");
    if (query.includes("FROM workspaces")) {
      const id = String(values[0] ?? "");
      const slug = workspaceSlugForWorkspaceId.get(id);
      return Promise.resolve(slug ? [{ slug }] : []);
    }
    return Promise.resolve([]);
  }) as never;

  const internal = createInternalRoutes({
    events,
    sessions,
    agents,
    grants,
    githubClient: null,
    internalToken: TOKEN,
    uploads,
    uploadStorage: storage,
    sql: fakeSql,
  });

  const app = new Hono();
  app.route("/api/internal", internal);

  return {
    app,
    uploads,
    storage,
    agents,
    sessions,
    workspaceSlugForWorkspaceId,
  };
}

async function seedUploadInWorkspace(
  h: Harness,
  opts: {
    uploadId: string;
    workspaceSlug: string;
    userId: string;
    body: Uint8Array;
    mime: string;
    /** Whether to bind the upload to a session in this workspace. */
    boundSession: boolean;
  },
): Promise<{ sessionId: string | null }> {
  const wsId = WorkspaceId(`019da258-0000-7efa-98a1-${randSuffix(opts.workspaceSlug)}`);
  h.workspaceSlugForWorkspaceId.set(wsId, opts.workspaceSlug);

  const agent = await h.agents.create({
    workspaceId: wsId,
    slug: WorkspaceSlug(`agent-${opts.workspaceSlug}`),
    name: "A",
    runtimeType: "claude_code" as never,
    kind: "worker" as never,
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: null,
  });

  let sessionId: string | null = null;
  if (opts.boundSession) {
    const s = await h.sessions.create({
      agentId: agent.id,
      triggeredBy: "user",
      triggeredByUserId: opts.userId as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });
    sessionId = s.id;
  }

  const id = UploadId(opts.uploadId);
  await h.storage.putObject(`uploads/test/${opts.uploadId}.bin`, opts.body);
  await h.uploads.insert({
    id,
    userId: UserId(opts.userId),
    sessionId,
    filename: "x.png",
    mime: opts.mime,
    sizeBytes: opts.body.byteLength,
    storageKey: `uploads/test/${opts.uploadId}.bin`,
    status: "ready",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });

  return { sessionId };
}

function randSuffix(seed: string): string {
  // Deterministic 12-hex from seed.
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  const hex = Math.abs(h).toString(16).padStart(12, "0").slice(0, 12);
  return hex;
}

const USER = "019da258-70a0-7efa-98a1-000000000001";
const OTHER_USER = "019da258-70a0-7efa-98a1-000000000002";
const ID_A = "019da258-70a0-7efa-98a1-aaaaaaaaaaaa";

describe("/api/internal/uploads/:id/raw — sidecar-facing credential proxy target", () => {
  it("returns bytes + X-Upload-Workspace-Slug when caller's user_id + session_id match the upload's bound session", async () => {
    const h = await setup();
    const seeded = await seedUploadInWorkspace(h, {
      uploadId: ID_A,
      workspaceSlug: "acme",
      userId: USER,
      body: new Uint8Array([1, 2, 3, 4]),
      mime: "image/png",
      boundSession: true,
    });

    const res = await h.app.fetch(
      new Request(
        `http://api.test/api/internal/uploads/${ID_A}/raw?user_id=${USER}&session_id=${seeded.sessionId}`,
        { headers: { "X-Internal-Token": TOKEN } },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Upload-Workspace-Slug")).toBe("acme");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(4);
  });

  it("returns 404 (not 403) when the caller's user_id doesn't own the upload — no existence leak", async () => {
    const h = await setup();
    await seedUploadInWorkspace(h, {
      uploadId: ID_A,
      workspaceSlug: "acme",
      userId: USER,
      body: new Uint8Array([1]),
      mime: "image/png",
      boundSession: true,
    });

    const res = await h.app.fetch(
      new Request(
        `http://api.test/api/internal/uploads/${ID_A}/raw?user_id=${OTHER_USER}&session_id=anything`,
        { headers: { "X-Internal-Token": TOKEN } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the caller's session_id doesn't match the upload's bound session", async () => {
    const h = await setup();
    await seedUploadInWorkspace(h, {
      uploadId: ID_A,
      workspaceSlug: "acme",
      userId: USER,
      body: new Uint8Array([1]),
      mime: "image/png",
      boundSession: true,
    });

    const res = await h.app.fetch(
      new Request(
        `http://api.test/api/internal/uploads/${ID_A}/raw?user_id=${USER}&session_id=019da258-70a0-7efa-98a1-bbbbbbbbbbbb`,
        { headers: { "X-Internal-Token": TOKEN } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("omits the workspace-slug header for unbound uploads (no session yet) — sidecar falls back to user_id check", async () => {
    const h = await setup();
    await seedUploadInWorkspace(h, {
      uploadId: ID_A,
      workspaceSlug: "acme",
      userId: USER,
      body: new Uint8Array([1, 2]),
      mime: "image/png",
      boundSession: false,
    });

    const res = await h.app.fetch(
      new Request(
        `http://api.test/api/internal/uploads/${ID_A}/raw?user_id=${USER}`,
        { headers: { "X-Internal-Token": TOKEN } },
      ),
    );
    expect(res.status).toBe(200);
    // No bound session ⇒ no workspace ⇒ no header. Sidecar will skip
    // its workspace cross-check; the user_id match above is the
    // boundary.
    expect(res.headers.get("X-Upload-Workspace-Slug")).toBeNull();
  });

  it("rejects callers missing the internal token (401) — proves the master token is still the route gate", async () => {
    const h = await setup();
    await seedUploadInWorkspace(h, {
      uploadId: ID_A,
      workspaceSlug: "acme",
      userId: USER,
      body: new Uint8Array([1]),
      mime: "image/png",
      boundSession: true,
    });
    const res = await h.app.fetch(
      new Request(
        `http://api.test/api/internal/uploads/${ID_A}/raw?user_id=${USER}`,
      ),
    );
    expect(res.status).toBe(401);
  });

  it("requires user_id (400) — the agent's sidecar always sends it; missing it is a programming error", async () => {
    const h = await setup();
    await seedUploadInWorkspace(h, {
      uploadId: ID_A,
      workspaceSlug: "acme",
      userId: USER,
      body: new Uint8Array([1]),
      mime: "image/png",
      boundSession: true,
    });
    const res = await h.app.fetch(
      new Request(`http://api.test/api/internal/uploads/${ID_A}/raw`, {
        headers: { "X-Internal-Token": TOKEN },
      }),
    );
    expect(res.status).toBe(400);
  });
});
