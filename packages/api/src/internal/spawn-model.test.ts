import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
  AgentId,
  InMemoryAgentRepository,
  type Agent,
} from "@x1agent/domain-agents";
import { WorkspaceId } from "@x1agent/kernel";
import {
  InMemorySessionRepository,
  InMemorySessionEventRepository,
} from "@x1agent/domain-sessions";
import { InMemoryPermissionGrantRepository } from "@x1agent/domain-permissions";
import { createInternalRoutes, resolveSpawnModel } from "./routes.js";
import { QuietHintStore } from "../orchestration/quiet-hints.js";

/**
 * X1A-40 — per-spawn `model` argument on the internal /sessions/spawn
 * route. Two surfaces under test:
 *
 *   1. resolveSpawnModel(raw, enabled) — pure helper that maps short
 *      names → full ids via the admin-enabled set and validates full
 *      ids against the same set. The brief calls this "case-
 *      insensitive short-name → full Claude model id" mapping.
 *
 *   2. POST /sessions/spawn — the route forwards the override down
 *      onto the session row when accepted, returns 403
 *      model_not_enabled when rejected, and leaves session.model_override
 *      null when the caller omits the field.
 */

const TOKEN = "test-internal-token";
const WS = WorkspaceId("019da258-70a0-7efa-98a1-47cdc5f9e000");

interface Fixture {
  app: Hono;
  agents: InMemoryAgentRepository;
  sessions: InMemorySessionRepository;
  grants: InMemoryPermissionGrantRepository;
  parentAgent: Agent;
  childAgent: Agent;
  parentSessionId: string;
}

async function setup(opts: {
  enabledModels?: () => Promise<Set<string> | null>;
} = {}): Promise<Fixture> {
  const agents = new InMemoryAgentRepository();
  const sessions = new InMemorySessionRepository();
  const events = new InMemorySessionEventRepository();
  const grants = new InMemoryPermissionGrantRepository();

  const parentAgent = await agents.create({
    workspaceId: WS,
    slug: "orchestrator" as never,
    name: "Orchestrator",
    runtimeType: "claude_code" as never,
    kind: "orchestrator" as never,
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: null,
  } as never);
  const childAgent = await agents.create({
    workspaceId: WS,
    slug: "writer" as never,
    name: "Writer",
    runtimeType: "claude_code" as never,
    kind: "worker" as never,
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: null,
  } as never);

  // Pre-seed the spawn grant — the route delegates to the same
  // findActiveGrant check used in production.
  await grants.create({
    workspaceId: WS,
    subject: { kind: "agent", agentId: parentAgent.id },
    grantType: "spawn" as never,
    details: { child_agent_id: childAgent.id },
    scope: "workspace" as never,
    sessionId: null,
    grantedByUserId: null,
    reason: null,
  } as never);

  const parentSession = await sessions.create({
    agentId: parentAgent.id,
    triggeredBy: "user",
    triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: new Date(),
  });

  const internal = createInternalRoutes({
    events,
    sessions,
    agents,
    grants,
    githubClient: null,
    internalToken: TOKEN,
    quietHints: new QuietHintStore(),
    enabledModels: opts.enabledModels,
  });

  const app = new Hono();
  app.route("/api/internal", internal);

  return {
    app,
    agents,
    sessions,
    grants,
    parentAgent,
    childAgent,
    parentSessionId: parentSession.id,
  };
}

async function spawn(
  f: Fixture,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await f.app.fetch(
    new Request("http://api.test/api/internal/sessions/spawn", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": TOKEN,
      },
      body: JSON.stringify({
        parent_session_id: f.parentSessionId,
        child_agent_id: f.childAgent.id,
        ...body,
      }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("resolveSpawnModel", () => {
  const enabled = new Set([
    "claude-sonnet-4-5@20250929",
    "claude-sonnet-4-5@default",
    "claude-opus-4-1@20250101",
    "claude-3-5-haiku@20240620",
  ]);

  it("resolves a short sonnet name to the newest GA id in the enabled set", () => {
    expect(resolveSpawnModel("sonnet", enabled)).toBe(
      "claude-sonnet-4-5@20250929",
    );
  });

  it("is case-insensitive on short names", () => {
    expect(resolveSpawnModel("OPUS", enabled)).toBe(
      "claude-opus-4-1@20250101",
    );
  });

  it("resolves haiku", () => {
    expect(resolveSpawnModel("haiku", enabled)).toBe(
      "claude-3-5-haiku@20240620",
    );
  });

  it("passes a full id through when it's in the enabled set", () => {
    expect(
      resolveSpawnModel("claude-opus-4-1@20250101", enabled),
    ).toBe("claude-opus-4-1@20250101");
  });

  it("returns null for a full id that isn't enabled", () => {
    expect(
      resolveSpawnModel("claude-opus-4-9@20991231", enabled),
    ).toBeNull();
  });

  it("returns null for a short name with no matching enabled id", () => {
    expect(resolveSpawnModel("sonnet", new Set(["claude-3-5-haiku@x"]))).toBeNull();
  });

  it("prefers GA ids over @default aliases", () => {
    const ga = new Set(["claude-sonnet-4-5@20250929", "claude-sonnet-4-5@default"]);
    expect(resolveSpawnModel("sonnet", ga)).toBe(
      "claude-sonnet-4-5@20250929",
    );
  });

  it("falls back to @default when only an alias is enabled", () => {
    const only = new Set(["claude-sonnet-4-6@default"]);
    expect(resolveSpawnModel("sonnet", only)).toBe(
      "claude-sonnet-4-6@default",
    );
  });

  it("rejects every model when the enabled set is empty", () => {
    expect(resolveSpawnModel("sonnet", new Set())).toBeNull();
    expect(
      resolveSpawnModel("claude-sonnet-4-5@20250929", new Set()),
    ).toBeNull();
  });

  it("accepts any non-empty value when no enabled set is wired (test surface)", () => {
    expect(resolveSpawnModel("sonnet", null)).toBe("sonnet");
  });
});

describe("POST /sessions/spawn — model override (X1A-40)", () => {
  it("writes the resolved full id onto the session for model: 'sonnet'", async () => {
    const f = await setup({
      enabledModels: async () =>
        new Set(["claude-sonnet-4-5@20250929", "claude-opus-4-1@20250101"]),
    });

    const res = await spawn(f, { model: "sonnet" });

    expect(res.status).toBe(201);
    const sessionId = (res.body as { session: { id: string } }).session.id;
    const stored = await f.sessions.findById(sessionId as never);
    expect(stored?.modelOverride).toBe("claude-sonnet-4-5@20250929");
  });

  it("returns 403 model_not_enabled for a model not in the allowlist", async () => {
    const f = await setup({
      enabledModels: async () =>
        new Set(["claude-sonnet-4-5@20250929"]),
    });

    const res = await spawn(f, { model: "not-real" });

    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("model_not_enabled");
  });

  it("leaves session.modelOverride null when the caller omits model", async () => {
    const f = await setup({
      enabledModels: async () =>
        new Set(["claude-sonnet-4-5@20250929"]),
    });

    const res = await spawn(f, {});

    expect(res.status).toBe(201);
    const sessionId = (res.body as { session: { id: string } }).session.id;
    const stored = await f.sessions.findById(sessionId as never);
    expect(stored?.modelOverride).toBeNull();
  });

  it("treats empty string the same as omission (no override, no 403)", async () => {
    const f = await setup({
      enabledModels: async () =>
        new Set(["claude-sonnet-4-5@20250929"]),
    });

    const res = await spawn(f, { model: "" });

    expect(res.status).toBe(201);
    const sessionId = (res.body as { session: { id: string } }).session.id;
    const stored = await f.sessions.findById(sessionId as never);
    expect(stored?.modelOverride).toBeNull();
  });
});
