import { describe, it, expect, beforeEach } from "bun:test";
import { FixedClock, UserId, WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import {
  AgentId,
  CronSchedule,
  InMemoryAgentRepository,
  RuntimeType,
  createAgent,
  AllowAllAdmin as AgentsAllowAll,
} from "@x1agent/domain-agents";
import { triggerSession } from "./trigger-session.js";
import { deleteSessions } from "./delete-sessions.js";
import { SessionId } from "../domain/session.js";
import {
  AllowAllAdmin,
  DenyAdmin,
  InMemorySessionRepository,
} from "./fakes.js";

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ACTOR = UserId(uuid(1));
const WS = WorkspaceId(uuid(2));

let agents: InMemoryAgentRepository;
let sessions: InMemorySessionRepository;
let clock: FixedClock;

beforeEach(() => {
  agents = new InMemoryAgentRepository();
  sessions = new InMemorySessionRepository();
  clock = new FixedClock(new Date("2026-04-18T12:00:00Z"));
});

async function makeAgent(slug: string = "an-agent") {
  return await createAgent(
    { agents, adminGuard: new AgentsAllowAll() },
    {
      actor: ACTOR,
      workspaceId: WS,
      slug: WorkspaceSlug(slug),
      name: "A",
      runtimeType: RuntimeType("claude_code"),
      kind: "worker",
      schedule: null,
      systemPrompt: "",
      heartbeatMd: "",
    },
  );
}

async function makeSession(agentId: AgentId) {
  return triggerSession(
    {
      agents,
      sessions,
      adminGuard: new AllowAllAdmin(),
      clock,
    },
    {
      actor: ACTOR,
      agentId,
      triggeredBy: "user",
      kind: "interactive",
    },
  );
}

describe("deleteSessions", () => {
  it("deletes sessions belonging to the workspace", async () => {
    const a = await makeAgent();
    const s1 = await makeSession(a.id);
    clock.advance(1);
    const s2 = await makeSession(a.id);
    expect(sessions.rows).toHaveLength(2);

    const r = await deleteSessions(
      { agents, sessions, adminGuard: new AllowAllAdmin() },
      ACTOR,
      WS,
      [s1.id],
    );
    expect(r.deleted).toEqual([s1.id]);
    expect(r.notFound).toEqual([]);
    expect(sessions.rows.map((r) => r.id)).toEqual([s2.id]);
  });

  it("returns notFound for ids that don't exist", async () => {
    const ghost = SessionId(uuid(99));
    const r = await deleteSessions(
      { agents, sessions, adminGuard: new AllowAllAdmin() },
      ACTOR,
      WS,
      [ghost],
    );
    expect(r.deleted).toEqual([]);
    expect(r.notFound).toEqual([ghost]);
  });

  it("refuses to delete sessions in another workspace", async () => {
    const a = await makeAgent();
    const s = await makeSession(a.id);
    const otherWs = WorkspaceId(uuid(3));
    const r = await deleteSessions(
      { agents, sessions, adminGuard: new AllowAllAdmin() },
      ACTOR,
      otherWs,
      [s.id],
    );
    // Workspace-membership check classifies cross-workspace ids as
    // not_found (silent) rather than 403, so a probe can't enumerate
    // session ids that exist in workspaces the caller can't see.
    expect(r.deleted).toEqual([]);
    expect(r.notFound).toEqual([s.id]);
    expect(sessions.rows).toHaveLength(1);
  });

  it("refuses if the actor is not a workspace admin", async () => {
    const a = await makeAgent();
    const s = await makeSession(a.id);
    await expect(
      deleteSessions(
        { agents, sessions, adminGuard: new DenyAdmin() },
        ACTOR,
        WS,
        [s.id],
      ),
    ).rejects.toThrow();
    expect(sessions.rows).toHaveLength(1);
  });

  it("handles a mix of valid + invalid ids in one call", async () => {
    const a = await makeAgent();
    const real = await makeSession(a.id);
    const ghost = SessionId(uuid(98));
    const r = await deleteSessions(
      { agents, sessions, adminGuard: new AllowAllAdmin() },
      ACTOR,
      WS,
      [real.id, ghost],
    );
    expect(r.deleted).toEqual([real.id]);
    expect(r.notFound).toEqual([ghost]);
  });
});
