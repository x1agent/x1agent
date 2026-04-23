import { describe, it, expect, beforeEach } from "bun:test";
import { FixedClock, UserId, WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import {
  AgentId,
  AgentNotFoundError,
  CronSchedule,
  InMemoryAgentRepository,
  RuntimeType,
  createAgent,
  AllowAllAdmin as AgentsAllowAll,
} from "@x1agent/domain-agents";
import {
  SessionAlreadyTerminalError,
  SessionId,
  SessionNotFoundError,
} from "../domain/session.js";
import { triggerSession } from "./trigger-session.js";
import { listSessions } from "./list-sessions.js";
import { cancelSession } from "./cancel-session.js";
import { scheduleDueSessions } from "./schedule-due-sessions.js";
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

async function makeAgent(opts: {
  slug?: string;
  schedule?: string | null;
  isActive?: boolean;
  kind?: "worker" | "orchestrator" | "scheduled";
} = {}) {
  const a = await createAgent(
    { agents, adminGuard: new AgentsAllowAll() },
    {
      actor: ACTOR,
      workspaceId: WS,
      slug: WorkspaceSlug(opts.slug ?? "heartbeat"),
      name: "H",
      runtimeType: RuntimeType("claude_code"),
      kind: opts.kind,
      schedule:
        opts.schedule === null
          ? null
          : opts.schedule !== undefined
            ? CronSchedule(opts.schedule)
            : null,
    },
  );
  if (opts.isActive === false) {
    await agents.update(a.id, { isActive: false });
  }
  return a;
}

describe("triggerSession", () => {
  it("records a pending user-triggered session", async () => {
    const a = await makeAgent();
    const s = await triggerSession(
      { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
      { actor: ACTOR, agentId: a.id },
    );
    expect(s.status).toBe("pending");
    expect(s.triggeredBy).toBe("user");
    expect(s.triggeredByUserId).toBe(ACTOR);
    expect(s.agentId).toBe(a.id);
    expect(s.triggeredAt.toISOString()).toBe("2026-04-18T12:00:00.000Z");
  });

  it("requires admin", async () => {
    const a = await makeAgent();
    await expect(
      triggerSession(
        { agents, sessions, adminGuard: new DenyAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects when the agent doesn't exist", async () => {
    await expect(
      triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: AgentId(uuid(999)) },
      ),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  describe("orchestrator singleton semantics", () => {
    it("worker triggers always produce a new session", async () => {
      const a = await makeAgent({ kind: "worker" });
      const s1 = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      clock.advance(1000);
      const s2 = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      expect(s2.id).not.toBe(s1.id);
      expect(sessions.rows.length).toBe(2);
    });

    it("orchestrator with no live session creates one", async () => {
      const a = await makeAgent({ kind: "orchestrator" });
      const s = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      expect(s.status).toBe("pending");
      expect(sessions.rows.length).toBe(1);
    });

    it("orchestrator with a pending session returns the same session — no new row", async () => {
      const a = await makeAgent({ kind: "orchestrator" });
      const first = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      clock.advance(1000);
      const second = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      expect(second.id).toBe(first.id);
      expect(sessions.rows.length).toBe(1);
    });

    it("orchestrator with a running session returns the same session", async () => {
      const a = await makeAgent({ kind: "orchestrator" });
      const first = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      await sessions.updateStatus(first.id, { status: "running" });
      clock.advance(1000);
      const second = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      expect(second.id).toBe(first.id);
      expect(sessions.rows.length).toBe(1);
    });

    it("orchestrator whose prior session completed gets a fresh session", async () => {
      const a = await makeAgent({ kind: "orchestrator" });
      const first = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      await sessions.updateStatus(first.id, {
        status: "complete",
        completedAt: clock.now(),
      });
      clock.advance(1000);
      const second = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      expect(second.id).not.toBe(first.id);
      expect(sessions.rows.length).toBe(2);
    });

    it("orchestrator whose prior session failed gets a fresh session", async () => {
      const a = await makeAgent({ kind: "orchestrator" });
      const first = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      await sessions.updateStatus(first.id, {
        status: "failed",
        completedAt: clock.now(),
        errorMessage: "crashed",
      });
      clock.advance(1000);
      const second = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      expect(second.id).not.toBe(first.id);
      expect(sessions.rows.length).toBe(2);
    });

    it("scheduled agent behaves like worker — new session per trigger", async () => {
      const a = await makeAgent({ kind: "scheduled" });
      const s1 = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      clock.advance(1000);
      const s2 = await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
      expect(s2.id).not.toBe(s1.id);
      expect(sessions.rows.length).toBe(2);
    });
  });
});

describe("listSessions", () => {
  it("returns newest-first, respects limit", async () => {
    const a = await makeAgent();
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      await triggerSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      );
    }
    const rows = await listSessions(
      { agents, sessions, adminGuard: new AllowAllAdmin() },
      ACTOR,
      a.id,
      2,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.triggeredAt.getTime()).toBeGreaterThan(
      rows[1]!.triggeredAt.getTime(),
    );
  });
});

describe("cancelSession", () => {
  it("marks a pending session failed", async () => {
    const a = await makeAgent();
    const s = await triggerSession(
      { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
      { actor: ACTOR, agentId: a.id },
    );
    clock.advance(60_000);
    const cancelled = await cancelSession(
      { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
      ACTOR,
      s.id,
    );
    expect(cancelled.status).toBe("failed");
    expect(cancelled.errorMessage).toBe("cancelled");
    expect(cancelled.completedAt?.toISOString()).toBe(
      "2026-04-18T12:01:00.000Z",
    );
  });

  it("refuses to cancel a terminal session", async () => {
    const a = await makeAgent();
    const s = await triggerSession(
      { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
      { actor: ACTOR, agentId: a.id },
    );
    await sessions.updateStatus(s.id, {
      status: "complete",
      completedAt: clock.now(),
    });
    await expect(
      cancelSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        ACTOR,
        s.id,
      ),
    ).rejects.toBeInstanceOf(SessionAlreadyTerminalError);
  });

  it("404s for an unknown id", async () => {
    await expect(
      cancelSession(
        { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
        ACTOR,
        SessionId(uuid(900)),
      ),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("scheduleDueSessions", () => {
  // Seeding a prior scheduler session pins the anchor so tests don't depend
  // on the in-memory agent fake's wall-clock createdAt.
  async function seedPriorRun(agentId: AgentId, at: Date) {
    await sessions.create({
      agentId,
      triggeredBy: "scheduler",
      triggeredByUserId: null,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: at,
    });
  }

  it("fires a run when an agent is due", async () => {
    const a = await makeAgent({ schedule: "@hourly" });
    await seedPriorRun(a.id, new Date("2026-04-18T11:30:00Z"));
    clock.set(new Date("2026-04-18T12:05:00Z"));
    const result = await scheduleDueSessions({ agents, sessions, clock });
    expect(result.created).toBe(1);
    expect(result.considered).toBe(1);
    const rows = await sessions.listByAgent(a.id, 10);
    // seed + new
    expect(rows).toHaveLength(2);
    expect(rows[0]!.triggeredBy).toBe("scheduler");
    expect(rows[0]!.triggeredByUserId).toBeNull();
    // @hourly next after 11:30 is 12:00 on the hour boundary.
    expect(rows[0]!.triggeredAt.toISOString()).toBe(
      "2026-04-18T12:00:00.000Z",
    );
  });

  it("does not fire twice for the same slot", async () => {
    const a = await makeAgent({ schedule: "@hourly" });
    await seedPriorRun(a.id, new Date("2026-04-18T11:30:00Z"));
    clock.set(new Date("2026-04-18T12:05:00Z"));
    const first = await scheduleDueSessions({ agents, sessions, clock });
    expect(first.created).toBe(1);
    // Same clock — next due after 12:00 is 13:00, not yet due.
    const second = await scheduleDueSessions({ agents, sessions, clock });
    expect(second.created).toBe(0);
  });

  it("fires one catch-up run after a long outage, not many", async () => {
    const a = await makeAgent({ schedule: "@hourly" });
    await seedPriorRun(a.id, new Date("2026-04-18T00:00:00Z"));
    clock.set(new Date("2026-04-18T06:05:00Z"));
    const result = await scheduleDueSessions({ agents, sessions, clock });
    expect(result.created).toBe(1);
  });

  it("honors @every Nm", async () => {
    const a = await makeAgent({ schedule: "@every 15m" });
    await seedPriorRun(a.id, new Date("2026-04-18T12:00:00Z"));
    clock.set(new Date("2026-04-18T12:16:00Z"));
    const result = await scheduleDueSessions({ agents, sessions, clock });
    expect(result.created).toBe(1);
  });

  it("ignores inactive agents", async () => {
    const a = await makeAgent({ schedule: "@hourly", isActive: false });
    await seedPriorRun(a.id, new Date("2026-04-18T11:30:00Z"));
    clock.set(new Date("2026-04-18T13:05:00Z"));
    const result = await scheduleDueSessions({ agents, sessions, clock });
    expect(result.considered).toBe(0);
    expect(result.created).toBe(0);
  });

  it("ignores manual-only agents", async () => {
    await makeAgent({ schedule: null });
    clock.set(new Date("2026-04-18T13:05:00Z"));
    const result = await scheduleDueSessions({ agents, sessions, clock });
    expect(result.considered).toBe(0);
    expect(result.created).toBe(0);
  });
});
