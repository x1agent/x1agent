import { describe, it, expect, beforeEach } from "bun:test";
import { DomainError, WorkspaceId } from "@x1agent/kernel";
import {
  AgentId,
  InMemoryAgentRepository,
  type Agent,
} from "@x1agent/domain-agents";
import { InMemorySessionRepository } from "./fakes.js";
import { SessionId } from "../domain/session.js";
import {
  spawnChildSession,
  type SpawnCheck,
} from "./spawn-child-session.js";

class StubClock {
  constructor(private t: Date) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

class AllowEverything implements SpawnCheck {
  async canSpawn() {
    return true;
  }
}
class DenyEverything implements SpawnCheck {
  async canSpawn() {
    return false;
  }
}

const ws = WorkspaceId("019da258-70a0-7efa-98a1-47cdc5f9e000");
const otherWs = WorkspaceId("019da258-70a0-7efa-98a1-47cdc5f9e999");

let agents: InMemoryAgentRepository;
let sessions: InMemorySessionRepository;
let clock: StubClock;

beforeEach(() => {
  agents = new InMemoryAgentRepository();
  sessions = new InMemorySessionRepository();
  clock = new StubClock(new Date("2026-04-19T12:00:00Z"));
});

async function seedAgent(overrides: {
  slug: string;
  workspaceId?: typeof ws;
  kind?: "worker" | "orchestrator" | "scheduled";
}): Promise<Agent> {
  return agents.create({
    workspaceId: overrides.workspaceId ?? ws,
    slug: overrides.slug as never,
    name: overrides.slug,
    runtimeType: "claude_code" as never,
    kind: overrides.kind,
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: null,
  } as never);
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    throw new Error(`expected rejection with code ${code}`);
  } catch (err) {
    if (!(err instanceof DomainError))
      throw new Error(`expected DomainError, got ${String(err)}`);
    expect(err.code).toBe(code);
  }
}

describe("spawnChildSession", () => {
  it("persists modelOverride when the caller passes one (X1A-40)", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const child = await seedAgent({ slug: "writer" });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date("2026-04-19T11:00:00Z"),
    });

    const out = await spawnChildSession(
      { agents, sessions, permission: new AllowEverything(), clock },
      {
        parentSessionId: parentSession.id,
        childAgentId: child.id,
        modelOverride: "claude-sonnet-4-5@20250929",
      },
    );

    expect(out.modelOverride).toBe("claude-sonnet-4-5@20250929");
  });

  it("leaves modelOverride null when the caller omits it", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const child = await seedAgent({ slug: "writer" });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date("2026-04-19T11:00:00Z"),
    });

    const out = await spawnChildSession(
      { agents, sessions, permission: new AllowEverything(), clock },
      { parentSessionId: parentSession.id, childAgentId: child.id },
    );

    expect(out.modelOverride).toBeNull();
  });

  it("creates a child session linked to the parent", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const child = await seedAgent({ slug: "writer" });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date("2026-04-19T11:00:00Z"),
    });

    const out = await spawnChildSession(
      {
        agents,
        sessions,
        permission: new AllowEverything(),
        clock,
      },
      {
        parentSessionId: parentSession.id,
        childAgentId: child.id,
      },
    );

    expect(out.agentId).toBe(child.id);
    expect(out.triggeredBy).toBe("agent");
    expect(out.triggeredByUserId).toBeNull();
    expect(out.parentSessionId).toBe(parentSession.id);
    expect(out.parentAgentId).toBe(parent.id);
  });

  it("rejects when parent session is terminal", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const child = await seedAgent({ slug: "writer" });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date("2026-04-19T11:00:00Z"),
    });
    await sessions.updateStatus(parentSession.id, {
      status: "complete" as never,
      completedAt: new Date(),
    });

    await expectCode(
      spawnChildSession(
        {
          agents,
          sessions,
          permission: new AllowEverything(),
          clock,
        },
        { parentSessionId: parentSession.id, childAgentId: child.id },
      ),
      "parent_session_terminal",
    );
  });

  it("rejects when permission port denies", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const child = await seedAgent({ slug: "writer" });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date("2026-04-19T11:00:00Z"),
    });

    await expectCode(
      spawnChildSession(
        {
          agents,
          sessions,
          permission: new DenyEverything(),
          clock,
        },
        { parentSessionId: parentSession.id, childAgentId: child.id },
      ),
      "permission_required",
    );
  });

  it("rejects cross-workspace spawns", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const child = await seedAgent({
      slug: "writer",
      workspaceId: otherWs,
    });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date("2026-04-19T11:00:00Z"),
    });

    await expectCode(
      spawnChildSession(
        {
          agents,
          sessions,
          permission: new AllowEverything(),
          clock,
        },
        { parentSessionId: parentSession.id, childAgentId: child.id },
      ),
      "spawn_across_workspaces",
    );
  });

  it("rejects unknown parent session", async () => {
    const child = await seedAgent({ slug: "writer" });
    await expectCode(
      spawnChildSession(
        {
          agents,
          sessions,
          permission: new AllowEverything(),
          clock,
        },
        {
          parentSessionId: SessionId(
            "00000000-0000-0000-0000-000000000000",
          ),
          childAgentId: child.id,
        },
      ),
      "session_not_found",
    );
  });

  it("rejects unknown child agent", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date("2026-04-19T11:00:00Z"),
    });

    await expectCode(
      spawnChildSession(
        {
          agents,
          sessions,
          permission: new AllowEverything(),
          clock,
        },
        {
          parentSessionId: parentSession.id,
          childAgentId: AgentId("00000000-0000-0000-0000-000000000000"),
        },
      ),
      "agent_not_found",
    );
  });

  describe("orchestrator-as-child singleton semantics", () => {
    async function seedParentAndSession() {
      const parent = await seedAgent({ slug: "top-orchestrator" });
      const parentSession = await sessions.create({
        agentId: parent.id,
        triggeredBy: "user",
        triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: clock.now(),
      });
      return { parent, parentSession };
    }

    it("worker child always creates a new session", async () => {
      const { parentSession } = await seedParentAndSession();
      const worker = await seedAgent({ slug: "writer", kind: "worker" });

      const first = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: worker.id },
      );
      clock.advance(1000);
      const second = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: worker.id },
      );

      expect(second.id).not.toBe(first.id);
    });

    it("orchestrator child with no live session — creates one", async () => {
      const { parentSession } = await seedParentAndSession();
      const sub = await seedAgent({ slug: "sub-orchestrator", kind: "orchestrator" });

      const session = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: sub.id },
      );

      expect(session.agentId).toBe(sub.id);
      expect(session.parentSessionId).toBe(parentSession.id);
    });

    it("orchestrator child with a live session — returns the same session, no duplicate row", async () => {
      const { parentSession } = await seedParentAndSession();
      const sub = await seedAgent({ slug: "sub-orchestrator", kind: "orchestrator" });

      const first = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: sub.id },
      );
      const beforeCount = sessions.rows.length;

      const second = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: sub.id },
      );

      expect(second.id).toBe(first.id);
      expect(sessions.rows.length).toBe(beforeCount);
    });

    it("orchestrator child whose prior session completed — new session", async () => {
      const { parentSession } = await seedParentAndSession();
      const sub = await seedAgent({ slug: "sub-orchestrator", kind: "orchestrator" });

      const first = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: sub.id },
      );
      await sessions.updateStatus(first.id, {
        status: "complete",
        completedAt: clock.now(),
      });
      clock.advance(1000);

      const second = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: sub.id },
      );

      expect(second.id).not.toBe(first.id);
    });

    it("scheduled child behaves like worker", async () => {
      const { parentSession } = await seedParentAndSession();
      const sched = await seedAgent({ slug: "cron-worker", kind: "scheduled" });

      const first = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: sched.id },
      );
      clock.advance(1000);
      const second = await spawnChildSession(
        { agents, sessions, permission: new AllowEverything(), clock },
        { parentSessionId: parentSession.id, childAgentId: sched.id },
      );

      expect(second.id).not.toBe(first.id);
    });
  });
});
