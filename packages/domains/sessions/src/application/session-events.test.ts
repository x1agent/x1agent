import { describe, it, expect, beforeEach } from "bun:test";
import {
  FixedClock,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import {
  CronSchedule,
  InMemoryAgentRepository,
  RuntimeType,
  createAgent,
  AllowAllAdmin as AgentsAllowAll,
} from "@x1agent/domain-agents";
import { SessionEventDuplicateError } from "../domain/event.js";
import { SessionNotFoundError } from "../domain/session.js";
import { triggerSession } from "./trigger-session.js";
import { appendSessionEvent } from "./append-session-event.js";
import { listSessionEvents } from "./list-session-events.js";
import {
  AllowAllAdmin,
  InMemorySessionEventRepository,
  InMemorySessionRepository,
} from "./fakes.js";
import type { SessionId } from "../domain/session.js";

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const ACTOR = UserId(uuid(1));
const WS = WorkspaceId(uuid(2));

let agents: InMemoryAgentRepository;
let sessions: InMemorySessionRepository;
let events: InMemorySessionEventRepository;
let clock: FixedClock;

beforeEach(() => {
  agents = new InMemoryAgentRepository();
  sessions = new InMemorySessionRepository();
  events = new InMemorySessionEventRepository();
  clock = new FixedClock(new Date("2026-04-18T12:00:00Z"));
});

async function fixture() {
  const a = await createAgent(
    { agents, adminGuard: new AgentsAllowAll() },
    {
      actor: ACTOR,
      workspaceId: WS,
      slug: WorkspaceSlug("heartbeat"),
      name: "H",
      runtimeType: RuntimeType("claude_code"),
      schedule: CronSchedule("@hourly"),
    },
  );
  const s = await triggerSession(
    { agents, sessions, adminGuard: new AllowAllAdmin(), clock },
    { actor: ACTOR, agentId: a.id },
  );
  return { agent: a, session: s };
}

describe("appendSessionEvent", () => {
  it("records events in order", async () => {
    const { session } = await fixture();
    await appendSessionEvent(
      { events },
      {
        sessionId: session.id,
        seq: 0,
        type: "session.started",
        payload: {},
        timestamp: clock.now(),
      },
    );
    await appendSessionEvent(
      { events },
      {
        sessionId: session.id,
        seq: 1,
        type: "agent.text",
        payload: { text: "hi" },
        timestamp: clock.now(),
      },
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]!.type).toBe("session.started");
    expect(events.rows[1]!.type).toBe("agent.text");
  });

  it("returns null on duplicate (seq already recorded)", async () => {
    const { session } = await fixture();
    await appendSessionEvent(
      { events },
      {
        sessionId: session.id,
        seq: 0,
        type: "session.started",
        payload: {},
        timestamp: clock.now(),
      },
    );
    const r = await appendSessionEvent(
      { events },
      {
        sessionId: session.id,
        seq: 0,
        type: "session.started",
        payload: {},
        timestamp: clock.now(),
      },
    );
    expect(r).toBeNull();
  });

  it("repo throws SessionEventDuplicateError directly", async () => {
    const { session } = await fixture();
    await events.append({
      sessionId: session.id,
      seq: 0,
      type: "t",
      payload: {},
      timestamp: clock.now(),
    });
    await expect(
      events.append({
        sessionId: session.id,
        seq: 0,
        type: "t",
        payload: {},
        timestamp: clock.now(),
      }),
    ).rejects.toBeInstanceOf(SessionEventDuplicateError);
  });
});

describe("listSessionEvents", () => {
  it("returns oldest-first and includes the session", async () => {
    const { session } = await fixture();
    for (let i = 0; i < 3; i++) {
      await events.append({
        sessionId: session.id,
        seq: i,
        type: "agent.text",
        payload: { text: String(i) },
        timestamp: clock.now(),
      });
    }
    const r = await listSessionEvents(
      { agents, sessions, events, adminGuard: new AllowAllAdmin() },
      ACTOR,
      session.id,
    );
    expect(r.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(r.session.id).toBe(session.id);
  });

  it("respects after_seq", async () => {
    const { session } = await fixture();
    for (let i = 0; i < 5; i++) {
      await events.append({
        sessionId: session.id,
        seq: i,
        type: "agent.text",
        payload: {},
        timestamp: clock.now(),
      });
    }
    const r = await listSessionEvents(
      { agents, sessions, events, adminGuard: new AllowAllAdmin() },
      ACTOR,
      session.id,
      { afterSeq: 2 },
    );
    expect(r.events.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("404s for an unknown session id", async () => {
    await expect(
      listSessionEvents(
        { agents, sessions, events, adminGuard: new AllowAllAdmin() },
        ACTOR,
        uuid(999) as SessionId,
      ),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  // ── X1A-110 — share-comment wakes filter from the main timeline ───
  it("filters share-comment wakes (kind=comment_added / comment_resolved) from the timeline", async () => {
    const { session } = await fixture();
    // A normal human message …
    await events.append({
      sessionId: session.id,
      seq: 0,
      type: "user.message",
      payload: { text: "hello" },
      timestamp: clock.now(),
    });
    // … followed by a comment-wake-derived user.message — the api
    // subscriber tagged this on ingest. It SHOULD NOT surface in the
    // main session timeline; it belongs in the share's comment flyout.
    await events.append({
      sessionId: session.id,
      seq: 1,
      type: "user.message",
      payload: {
        text: "[wake: new comment on share abcd1234]\nBody:\nhi",
        kind: "comment_added",
        source: "platform",
        share_id: "share-1",
        thread_id: "thread-1",
      },
      timestamp: clock.now(),
    });
    // … and a comment-resolved wake too.
    await events.append({
      sessionId: session.id,
      seq: 2,
      type: "user.message",
      payload: {
        text: "[wake: comment thread resolved on share abcd1234]\n…",
        kind: "comment_resolved",
        source: "platform",
        share_id: "share-1",
        thread_id: "thread-1",
      },
      timestamp: clock.now(),
    });
    // … plus an agent reply that's NOT a wake — must survive.
    await events.append({
      sessionId: session.id,
      seq: 3,
      type: "agent.text",
      payload: { text: "ack" },
      timestamp: clock.now(),
    });
    const r = await listSessionEvents(
      { agents, sessions, events, adminGuard: new AllowAllAdmin() },
      ACTOR,
      session.id,
    );
    expect(r.events.map((e) => e.seq)).toEqual([0, 3]);
  });

  it("does NOT filter orchestration wakes (state_change, watchdog, …) — those still belong on the timeline", async () => {
    const { session } = await fixture();
    await events.append({
      sessionId: session.id,
      seq: 0,
      type: "user.message",
      payload: {
        text: "[driverless wake: child finished]\n…",
        kind: "state_change",
        source: "platform",
        driverless: true,
      },
      timestamp: clock.now(),
    });
    const r = await listSessionEvents(
      { agents, sessions, events, adminGuard: new AllowAllAdmin() },
      ACTOR,
      session.id,
    );
    expect(r.events).toHaveLength(1);
    expect(
      (r.events[0]!.payload as { kind: string }).kind,
    ).toBe("state_change");
  });
});
