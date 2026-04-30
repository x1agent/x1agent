import { describe, it, expect, beforeEach } from "bun:test";
import { FixedClock } from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import { SessionId } from "../domain/session.js";
import type { Session } from "../domain/session.js";
import { InMemorySessionRepository } from "./fakes.js";
import {
  reconcileSessionStatuses,
  type JobExistsFn,
  type StateChangeNotifier,
} from "./reconcile-session-status.js";

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const GRACE_MS = 120_000;
const NOW = new Date("2026-04-23T12:00:00Z");
const BEFORE_GRACE = new Date(NOW.getTime() - (GRACE_MS + 60_000));
const INSIDE_GRACE = new Date(NOW.getTime() - 30_000);

let sessions: InMemorySessionRepository;
let clock: FixedClock;
let notifyCalls: Array<{
  session: Session;
  completedAt: Date;
  errorMessage: string;
}>;
let notify: StateChangeNotifier;

beforeEach(() => {
  sessions = new InMemorySessionRepository();
  clock = new FixedClock(NOW);
  notifyCalls = [];
  notify = async (session, completedAt, errorMessage) => {
    notifyCalls.push({ session, completedAt, errorMessage });
  };
});

async function seedSession(opts: {
  id: number;
  status: "pending" | "running" | "complete" | "failed";
  triggeredAt: Date;
  parentSessionId?: number;
}): Promise<Session> {
  await sessions.create({
    agentId: AgentId(uuid(opts.id + 100)),
    triggeredBy: "scheduler",
    triggeredByUserId: null,
    parentSessionId: opts.parentSessionId
      ? SessionId(uuid(opts.parentSessionId))
      : null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: opts.triggeredAt,
  });
  // InMemorySessionRepository assigns its own id. Grab + override
  // status if the seed wants something other than 'pending'.
  const created = sessions.rows[sessions.rows.length - 1]!;
  if (opts.status !== "pending") {
    sessions.rows[sessions.rows.length - 1] = {
      ...created,
      status: opts.status,
      completedAt:
        opts.status === "complete" || opts.status === "failed"
          ? opts.triggeredAt
          : null,
    };
  }
  return sessions.rows[sessions.rows.length - 1]!;
}

const jobAlwaysExists: JobExistsFn = async () => true;
const jobNeverExists: JobExistsFn = async () => false;
const jobAlwaysThrows: JobExistsFn = async () => {
  throw new Error("apiserver unreachable");
};

describe("reconcileSessionStatuses", () => {
  it("flips a stale running session to failed when its Job is gone", async () => {
    const session = await seedSession({
      id: 1,
      status: "running",
      triggeredAt: BEFORE_GRACE,
    });

    const result = await reconcileSessionStatuses({
      sessions,
      clock,
      jobExists: jobNeverExists,
      notify,
      gracePeriodMs: GRACE_MS,
    });

    expect(result).toEqual({ checked: 1, flipped: 1, errors: 0 });

    const after = await sessions.findById(session.id);
    expect(after?.status).toBe("failed");
    expect(after?.completedAt).toEqual(NOW);
    expect(after?.errorMessage).toMatch(/pod_reconciler/);
  });

  it("leaves sessions inside the grace window untouched", async () => {
    await seedSession({
      id: 2,
      status: "running",
      triggeredAt: INSIDE_GRACE,
    });

    const result = await reconcileSessionStatuses({
      sessions,
      clock,
      jobExists: jobNeverExists,
      notify,
      gracePeriodMs: GRACE_MS,
    });

    expect(result).toEqual({ checked: 0, flipped: 0, errors: 0 });
    expect(sessions.rows[0]?.status).toBe("running");
  });

  it("leaves a running session with a live Job untouched", async () => {
    await seedSession({
      id: 3,
      status: "running",
      triggeredAt: BEFORE_GRACE,
    });

    const result = await reconcileSessionStatuses({
      sessions,
      clock,
      jobExists: jobAlwaysExists,
      notify,
      gracePeriodMs: GRACE_MS,
    });

    expect(result).toEqual({ checked: 1, flipped: 0, errors: 0 });
    expect(sessions.rows[0]?.status).toBe("running");
  });

  it("skips terminal sessions entirely (idempotent)", async () => {
    await seedSession({
      id: 4,
      status: "failed",
      triggeredAt: BEFORE_GRACE,
    });
    await seedSession({
      id: 5,
      status: "complete",
      triggeredAt: BEFORE_GRACE,
    });

    const result = await reconcileSessionStatuses({
      sessions,
      clock,
      jobExists: jobNeverExists,
      notify,
      gracePeriodMs: GRACE_MS,
    });

    expect(result).toEqual({ checked: 0, flipped: 0, errors: 0 });
    expect(notifyCalls).toHaveLength(0);
  });

  it("publishes a state_change wake for each flipped session", async () => {
    const orphan = await seedSession({
      id: 6,
      status: "running",
      triggeredAt: BEFORE_GRACE,
      parentSessionId: 99,
    });

    await reconcileSessionStatuses({
      sessions,
      clock,
      jobExists: jobNeverExists,
      notify,
      gracePeriodMs: GRACE_MS,
    });

    expect(notifyCalls).toHaveLength(1);
    const call = notifyCalls[0]!;
    expect(call.session.id).toBe(orphan.id);
    expect(call.session.status).toBe("failed");
    expect(call.completedAt).toEqual(NOW);
    expect(call.errorMessage).toMatch(/pod_reconciler/);
  });

  it("does not abort the batch when notify throws for one session", async () => {
    await seedSession({
      id: 7,
      status: "running",
      triggeredAt: BEFORE_GRACE,
    });
    await seedSession({
      id: 8,
      status: "running",
      triggeredAt: BEFORE_GRACE,
    });

    let firstCall = true;
    const flakeyNotify: StateChangeNotifier = async () => {
      if (firstCall) {
        firstCall = false;
        throw new Error("wake publish failed");
      }
    };

    const result = await reconcileSessionStatuses({
      sessions,
      clock,
      jobExists: jobNeverExists,
      notify: flakeyNotify,
      gracePeriodMs: GRACE_MS,
    });

    expect(result.checked).toBe(2);
    expect(result.flipped).toBe(2);
    expect(sessions.rows.every((r) => r.status === "failed")).toBe(true);
  });

  it("counts jobExists errors without flipping the session", async () => {
    await seedSession({
      id: 9,
      status: "running",
      triggeredAt: BEFORE_GRACE,
    });

    const result = await reconcileSessionStatuses({
      sessions,
      clock,
      jobExists: jobAlwaysThrows,
      notify,
      gracePeriodMs: GRACE_MS,
    });

    expect(result).toEqual({ checked: 1, flipped: 0, errors: 1 });
    expect(sessions.rows[0]?.status).toBe("running");
    expect(notifyCalls).toHaveLength(0);
  });
});
