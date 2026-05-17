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
  SessionDuplicateTickError,
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

  it("requires workspace membership (but not admin)", async () => {
    const a = await makeAgent();
    // DenyAdmin rejects both assertAdmin and assertMember — proxy for
    // "user is not a workspace member at all".
    await expect(
      triggerSession(
        { agents, sessions, adminGuard: new DenyAdmin(), clock },
        { actor: ACTOR, agentId: a.id },
      ),
    ).rejects.toBeTruthy();

    // A plain member (allowed by assertMember) should succeed without
    // assertAdmin ever being called.
    class MemberOnlyGuard {
      assertAdminCalled = false;
      async assertAdmin() {
        this.assertAdminCalled = true;
        throw new Error("admin gate must not be invoked from triggerSession");
      }
      async assertMember() {}
    }
    const guard = new MemberOnlyGuard();
    const s = await triggerSession(
      { agents, sessions, adminGuard: guard, clock },
      { actor: ACTOR, agentId: a.id },
    );
    expect(s.status).toBe("pending");
    expect(guard.assertAdminCalled).toBe(false);
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
  it("marks a pending session complete with cancelled errorMessage", async () => {
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
    // User-initiated cancel is a clean exit (`complete`), not a crash
    // (`failed`). The errorMessage carries the disambiguation for the
    // audit trail.
    expect(cancelled.status).toBe("complete");
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

  it("the triggerer (a plain member) can cancel their own session", async () => {
    const a = await makeAgent();
    // Trigger as ACTOR with a member-only guard — assertMember succeeds,
    // assertAdmin would throw if called.
    class MemberOnlyGuard {
      async assertAdmin(): Promise<never> {
        throw new Error("admin gate must not be hit when cancelling own session");
      }
      async assertMember() {}
    }
    const guard = new MemberOnlyGuard();
    const s = await triggerSession(
      { agents, sessions, adminGuard: guard, clock },
      { actor: ACTOR, agentId: a.id },
    );
    const cancelled = await cancelSession(
      { agents, sessions, adminGuard: guard, clock },
      ACTOR,
      s.id,
    );
    expect(cancelled.status).toBe("complete");
    expect(cancelled.errorMessage).toBe("cancelled");
  });

  it("a non-triggerer member is rejected — admin gate applies for somebody else's session", async () => {
    const a = await makeAgent();
    // Owner triggers as ACTOR (passes member check).
    const allow = new AllowAllAdmin();
    const s = await triggerSession(
      { agents, sessions, adminGuard: allow, clock },
      { actor: ACTOR, agentId: a.id },
    );
    // A different user (OTHER) tries to cancel — only assertAdmin is
    // consulted in this branch; DenyAdmin rejects.
    const OTHER = UserId(uuid(778));
    await expect(
      cancelSession(
        { agents, sessions, adminGuard: new DenyAdmin(), clock },
        OTHER,
        s.id,
      ),
    ).rejects.toBeTruthy();
  });

  it("terminates the backing K8s Job when the session was running (X1A-70)", async () => {
    const a = await makeAgent();
    const allow = new AllowAllAdmin();
    const s = await triggerSession(
      { agents, sessions, adminGuard: allow, clock },
      { actor: ACTOR, agentId: a.id },
    );
    // Pretend the job-watcher launched the pod and flipped to running.
    await sessions.updateStatus(s.id, { status: "running" });

    const terminated: string[] = [];
    const jobs = {
      async terminateForSession(id: SessionId) {
        terminated.push(id);
      },
    };

    const cancelled = await cancelSession(
      { agents, sessions, adminGuard: allow, clock, jobs },
      ACTOR,
      s.id,
    );
    expect(cancelled.status).toBe("complete");
    expect(terminated).toEqual([s.id]);
  });

  it("does NOT terminate the Job when the session was still pending (no Job to kill yet)", async () => {
    const a = await makeAgent();
    const allow = new AllowAllAdmin();
    const s = await triggerSession(
      { agents, sessions, adminGuard: allow, clock },
      { actor: ACTOR, agentId: a.id },
    );
    // Status stays pending — job-watcher hasn't launched yet.

    const terminated: string[] = [];
    const jobs = {
      async terminateForSession(id: SessionId) {
        terminated.push(id);
      },
    };

    await cancelSession(
      { agents, sessions, adminGuard: allow, clock, jobs },
      ACTOR,
      s.id,
    );
    expect(terminated).toEqual([]);
  });

  it("swallows Job-terminate errors so a K8s blip doesn't break cancel (X1A-70)", async () => {
    const a = await makeAgent();
    const allow = new AllowAllAdmin();
    const s = await triggerSession(
      { agents, sessions, adminGuard: allow, clock },
      { actor: ACTOR, agentId: a.id },
    );
    await sessions.updateStatus(s.id, { status: "running" });

    const jobs = {
      async terminateForSession() {
        throw new Error("k8s api flake");
      },
    };
    const cancelled = await cancelSession(
      { agents, sessions, adminGuard: allow, clock, jobs },
      ACTOR,
      s.id,
    );
    // DB-side cancel is the source of truth; reconciler picks up the
    // straggler on its next tick.
    expect(cancelled.status).toBe("complete");
    expect(cancelled.errorMessage).toBe("cancelled");
  });
});

describe("SessionDuplicateTickError messages (X1A-70)", () => {
  // The error class is shared across scheduler ticks, user Resumes,
  // and agent spawn races. The message text disambiguates so the
  // operator sees the right framing.
  const agentId = "test-agent" as never;
  const at = new Date("2026-05-14T22:00:00Z");

  it("scheduler tick message mentions scheduler", () => {
    const err = new SessionDuplicateTickError(agentId, at, "scheduler");
    expect(err.message).toContain("scheduler tick");
    expect(err.message).toContain(agentId);
  });

  it("user (Resume) message mentions concurrent Resume, not scheduler", () => {
    const err = new SessionDuplicateTickError(agentId, at, "user");
    expect(err.message).toContain("Resume");
    expect(err.message).not.toContain("scheduler");
  });

  it("agent spawn message mentions concurrent spawn", () => {
    const err = new SessionDuplicateTickError(agentId, at, "agent");
    expect(err.message).toContain("concurrent spawn");
    expect(err.message).not.toContain("scheduler");
  });

  it("falls back to a generic message when the source is unknown", () => {
    const err = new SessionDuplicateTickError(agentId, at);
    expect(err.message).toContain("already exists");
    expect(err.message).toContain(agentId);
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

  it("does not backfill missed slots after a long outage; advances anchor", async () => {
    // No-backfill policy (schedule-due-sessions.ts): if `due` is more
    // than one full interval behind `now`, the agent has been off long
    // enough that catching up by firing one session per missed slot is
    // wrong — that produces phantom backlogs. Skip the missed slots,
    // advance the anchor, and let the next future slot fire normally.
    const a = await makeAgent({ schedule: "@hourly" });
    await seedPriorRun(a.id, new Date("2026-04-18T00:00:00Z"));
    clock.set(new Date("2026-04-18T06:05:00Z"));
    const result = await scheduleDueSessions({ agents, sessions, clock });
    expect(result.created).toBe(0);
    // Anchor advanced so the next tick within the same interval is a
    // no-op rather than firing for the recent missed slot.
    const reloaded = await agents.findById(a.id);
    expect(reloaded!.lastSchedulerTickAt?.toISOString()).toBe(
      "2026-04-18T06:05:00.000Z",
    );
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

  describe("orchestrator heartbeat semantics", () => {
    class RecordingInjector {
      calls: Array<{ sessionId: string; text: string }> = [];
      async injectHeartbeatWake(sessionId: string, text: string) {
        this.calls.push({ sessionId, text });
      }
    }

    it("orchestrator with a live session — injects into it, no new row", async () => {
      const a = await makeAgent({
        slug: "orch",
        schedule: "@hourly",
        kind: "orchestrator",
      });
      // Seed the orchestrator's singleton live session (user-triggered,
      // still running).
      const live = await sessions.create({
        agentId: a.id,
        triggeredBy: "user",
        triggeredByUserId: ACTOR,
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: new Date("2026-04-18T10:00:00Z"),
      });
      await sessions.updateStatus(live.id, { status: "running" });
      // Seed the anchor one full hour ago so `due` is exactly the
      // current top-of-hour. Anchors further back hit the no-backfill
      // branch (schedule-due-sessions.ts:87) which advances the anchor
      // without firing — that's a separate property covered by the
      // catch-up test below.
      await agents.recordSchedulerTick(
        a.id,
        new Date("2026-04-18T12:30:00Z"),
      );
      clock.set(new Date("2026-04-18T13:05:00Z"));

      const injector = new RecordingInjector();
      const result = await scheduleDueSessions({
        agents,
        sessions,
        clock,
        injector,
      });

      expect(result.injected).toBe(1);
      expect(result.created).toBe(0);
      expect(injector.calls).toHaveLength(1);
      expect(injector.calls[0]!.sessionId).toBe(live.id);
      // live session + no second row
      const all = await sessions.listByAgent(a.id, 10);
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe(live.id);
      // Tick anchor updated so next tick doesn't fire immediately.
      const reloaded = await agents.findById(a.id);
      expect(reloaded!.lastSchedulerTickAt).not.toBeNull();
    });

    it("orchestrator with no live session — creates one (like a worker)", async () => {
      const a = await makeAgent({
        slug: "orch-cold",
        schedule: "@hourly",
        kind: "orchestrator",
      });
      // Anchor inside the previous slot so `due` is the current
      // top-of-hour; see the live-session test above for the rationale.
      await agents.recordSchedulerTick(
        a.id,
        new Date("2026-04-18T12:30:00Z"),
      );
      clock.set(new Date("2026-04-18T13:05:00Z"));

      const injector = new RecordingInjector();
      const result = await scheduleDueSessions({
        agents,
        sessions,
        clock,
        injector,
      });

      expect(result.created).toBe(1);
      expect(result.injected).toBe(0);
      expect(injector.calls).toHaveLength(0);
      const rows = await sessions.listByAgent(a.id, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.triggeredBy).toBe("scheduler");
    });

    it("orchestrator with a completed session — creates a new one (singleton is free)", async () => {
      const a = await makeAgent({
        slug: "orch-prior",
        schedule: "@hourly",
        kind: "orchestrator",
      });
      const prior = await sessions.create({
        agentId: a.id,
        triggeredBy: "user",
        triggeredByUserId: ACTOR,
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: new Date("2026-04-18T10:00:00Z"),
      });
      await sessions.updateStatus(prior.id, {
        status: "complete",
        completedAt: new Date("2026-04-18T10:30:00Z"),
      });
      // Anchor inside the previous slot — see live-session test rationale.
      await agents.recordSchedulerTick(
        a.id,
        new Date("2026-04-18T12:30:00Z"),
      );
      clock.set(new Date("2026-04-18T13:05:00Z"));

      const injector = new RecordingInjector();
      const result = await scheduleDueSessions({
        agents,
        sessions,
        clock,
        injector,
      });

      expect(result.created).toBe(1);
      expect(result.injected).toBe(0);
    });

    it("does not re-fire on the next tick in the same window (anchor advanced)", async () => {
      const a = await makeAgent({
        slug: "orch-anchor",
        schedule: "@hourly",
        kind: "orchestrator",
      });
      const live = await sessions.create({
        agentId: a.id,
        triggeredBy: "user",
        triggeredByUserId: ACTOR,
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: new Date("2026-04-18T10:00:00Z"),
      });
      await sessions.updateStatus(live.id, { status: "running" });
      // Seed the anchor within the current hour so there's exactly one
      // due slot to fire. Seeding further back triggers the catch-up
      // loop (one slot per call), which is intentional behavior but a
      // different property to test.
      await agents.recordSchedulerTick(
        a.id,
        new Date("2026-04-18T12:30:00Z"),
      );
      clock.set(new Date("2026-04-18T13:05:00Z"));

      const injector = new RecordingInjector();
      await scheduleDueSessions({ agents, sessions, clock, injector });
      await scheduleDueSessions({ agents, sessions, clock, injector });

      // First tick fired for 13:00 slot, anchor advanced to 13:00.
      // Second tick: next-due is 14:00 > clock 13:05, skip.
      expect(injector.calls).toHaveLength(1);
    });

    it("heartbeat wake text is the agent's heartbeatMd verbatim", async () => {
      const a = await makeAgent({
        slug: "orch-hb",
        schedule: "@hourly",
        kind: "orchestrator",
      });
      await agents.update(a.id, {
        heartbeatMd: "## Heartbeat\n\nCheck the roadmap and decide.",
      });
      const live = await sessions.create({
        agentId: a.id,
        triggeredBy: "user",
        triggeredByUserId: ACTOR,
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: new Date("2026-04-18T10:00:00Z"),
      });
      await sessions.updateStatus(live.id, { status: "running" });
      // Anchor inside the previous slot — see live-session test rationale.
      await agents.recordSchedulerTick(
        a.id,
        new Date("2026-04-18T12:30:00Z"),
      );
      clock.set(new Date("2026-04-18T13:05:00Z"));

      const injector = new RecordingInjector();
      await scheduleDueSessions({ agents, sessions, clock, injector });

      expect(injector.calls[0]!.text).toBe(
        "## Heartbeat\n\nCheck the roadmap and decide.",
      );
    });

    it("throws a surfaced error if no injector is configured and a live session exists", async () => {
      const a = await makeAgent({
        slug: "orch-no-injector",
        schedule: "@hourly",
        kind: "orchestrator",
      });
      const live = await sessions.create({
        agentId: a.id,
        triggeredBy: "user",
        triggeredByUserId: ACTOR,
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: new Date("2026-04-18T10:00:00Z"),
      });
      await sessions.updateStatus(live.id, { status: "running" });
      await agents.recordSchedulerTick(
        a.id,
        new Date("2026-04-18T12:30:00Z"),
      );
      clock.set(new Date("2026-04-18T13:05:00Z"));

      let surfaced: unknown = null;
      const result = await scheduleDueSessions({
        agents,
        sessions,
        clock,
        onError: (_, err) => {
          surfaced = err;
        },
      });

      expect(result.errors).toBe(1);
      expect(result.injected).toBe(0);
      expect(result.created).toBe(0);
      expect((surfaced as Error).message).toContain("MessageInjector");
    });

    it("no-backfill does NOT eat the first fire for an orchestrator whose anchor is far in the past", async () => {
      // Operator-reported symptom (2026-05-17): set a daily schedule on
      // an orchestrator that's been alive for days; the agent runs all
      // night and no heartbeat fires. Root cause was that the no-backfill
      // rule applied to orchestrators too. For orchestrators a missed
      // slot does NOT create a session backlog (the tick injects into
      // the live session), so the rule should only apply to workers.
      const a = await makeAgent({
        slug: "orch-stale-anchor",
        schedule: "30 5 * * *",
        kind: "orchestrator",
      });
      const live = await sessions.create({
        agentId: a.id,
        triggeredBy: "user",
        triggeredByUserId: ACTOR,
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: new Date("2026-05-15T10:00:00Z"),
      });
      await sessions.updateStatus(live.id, { status: "running" });
      // Seed lastSchedulerTickAt explicitly to a date 30 days back so
      // the no-backfill branch fires deterministically (the in-memory
      // agent fake stamps createdAt with real wall-clock time, not the
      // FixedClock, so anchor-from-createdAt isn't reliable in tests).
      // Pre-fix, the (now - due > intervalMs) check would advance the
      // anchor to now and skip without injecting.
      await agents.recordSchedulerTick(
        a.id,
        new Date("2026-04-17T12:00:00Z"),
      );
      clock.set(new Date("2026-05-17T05:35:00Z"));

      const injector = new RecordingInjector();
      const result = await scheduleDueSessions({
        agents,
        sessions,
        clock,
        injector,
      });

      expect(result.injected).toBe(1);
      expect(result.created).toBe(0);
      expect(injector.calls).toHaveLength(1);
      expect(injector.calls[0]!.sessionId).toBe(live.id);
    });

    it("no-backfill STILL applies to worker kinds (does not regress phantom-session prevention)", async () => {
      // Counter-test: the rule must keep firing for workers so a stale
      // anchor doesn't spawn N sessions catching up.
      const a = await makeAgent({
        slug: "worker-stale-anchor",
        schedule: "@hourly",
        kind: "worker",
      });
      // Anchor 10 hours behind now — far enough to trigger no-backfill.
      await seedPriorRun(a.id, new Date("2026-04-18T02:00:00Z"));
      clock.set(new Date("2026-04-18T13:05:00Z"));

      const result = await scheduleDueSessions({ agents, sessions, clock });

      // Pre-existing behavior: skip the backlog, advance anchor, no
      // new session row created.
      expect(result.created).toBe(0);
    });
  });
});
