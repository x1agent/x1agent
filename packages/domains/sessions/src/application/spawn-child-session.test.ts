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
}): Promise<Agent> {
  return agents.create({
    workspaceId: overrides.workspaceId ?? ws,
    slug: overrides.slug as never,
    name: overrides.slug,
    runtimeType: "claude_code" as never,
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
  it("creates a child session linked to the parent", async () => {
    const parent = await seedAgent({ slug: "orchestrator" });
    const child = await seedAgent({ slug: "writer" });
    const parentSession = await sessions.create({
      agentId: parent.id,
      triggeredBy: "user",
      triggeredByUserId: "019da258-70a0-7efa-98a1-000000000001" as never,
      parentSessionId: null,
      parentAgentId: null,
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
});
