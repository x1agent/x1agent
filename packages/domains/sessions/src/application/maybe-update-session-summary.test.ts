import { describe, it, expect, beforeEach } from "bun:test";
import { AgentId } from "@x1agent/domain-agents";
import {
  maybeUpdateSessionSummary,
  DEFAULT_SUMMARY_CONFIG,
} from "./maybe-update-session-summary.js";
import {
  InMemorySessionEventRepository,
  InMemorySessionRepository,
} from "./fakes.js";
import type { SessionSummarizer } from "../ports/session-summarizer.js";
import type { SessionEvent } from "../domain/event.js";
import { TriggerSource } from "../domain/trigger.js";
import { UserId } from "@x1agent/kernel";

class StaticClock {
  constructor(private current: Date) {}
  now() {
    return this.current;
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class RecordingSummarizer implements SessionSummarizer {
  calls: Array<{ events: readonly SessionEvent[] }> = [];
  constructor(private response: string | null) {}
  async summarize(events: readonly SessionEvent[]) {
    this.calls.push({ events });
    return this.response;
  }
}

const AGENT = AgentId("00000000-0000-7000-8000-0000000000a1");
const USER = UserId("00000000-0000-7000-8000-00000000a1ce");

describe("maybeUpdateSessionSummary", () => {
  let sessions: InMemorySessionRepository;
  let events: InMemorySessionEventRepository;
  let clock: StaticClock;

  beforeEach(() => {
    sessions = new InMemorySessionRepository();
    events = new InMemorySessionEventRepository();
    clock = new StaticClock(new Date("2026-05-09T12:00:00Z"));
  });

  async function seedSession() {
    return sessions.create({
      agentId: AGENT,
      triggeredBy: TriggerSource("user"),
      triggeredByUserId: USER,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: clock.now(),
    });
  }

  async function seedEvents(sessionId: string, count: number) {
    for (let i = 0; i < count; i++) {
      await events.append({
        sessionId: sessionId as never,
        seq: i,
        type: "user.message",
        payload: { text: `msg ${i}` },
        timestamp: new Date(`2026-05-09T12:00:0${i}Z`),
      });
    }
  }

  it("calls the summarizer and writes the row on first invocation", async () => {
    const session = await seedSession();
    await seedEvents(session.id, 3);
    const summarizer = new RecordingSummarizer("user is exploring foo");

    const result = await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 2 },
    );

    expect(result.kind).toBe("updated");
    expect(summarizer.calls).toHaveLength(1);
    const fresh = await sessions.findById(session.id);
    expect(fresh?.summary).toBe("user is exploring foo");
    expect(fresh?.summaryEventSeq).toBe(2);
    expect(fresh?.summaryUpdatedAt).toEqual(clock.now());
  });

  it("returns 'empty-summary' and does not write when summarizer returns null", async () => {
    const session = await seedSession();
    await seedEvents(session.id, 3);
    const summarizer = new RecordingSummarizer(null);

    const result = await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 2 },
    );

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toBe("empty-summary");
    }
    const fresh = await sessions.findById(session.id);
    expect(fresh?.summary).toBeNull();
  });

  it("skips when neither cooldown threshold has fired", async () => {
    const session = await seedSession();
    await seedEvents(session.id, 12);
    // First call seeds the summary.
    const summarizer = new RecordingSummarizer("first take");
    await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 11 },
    );
    expect(summarizer.calls).toHaveLength(1);

    // 2 events later, 30 seconds later: under both thresholds.
    clock.advance(30_000);
    const result = await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 13 },
    );
    expect(result.kind).toBe("skipped");
    expect(summarizer.calls).toHaveLength(1); // not re-called
  });

  it("re-summarizes once the events threshold is exceeded", async () => {
    const session = await seedSession();
    await seedEvents(session.id, 30);
    const summarizer = new RecordingSummarizer("first take");
    await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 5 },
    );
    summarizer.calls.length = 0;

    // 10 events past the previous summary watermark — fires.
    const result = await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 16 },
    );
    expect(result.kind).toBe("updated");
    expect(summarizer.calls).toHaveLength(1);
  });

  it("re-summarizes once the wall-clock interval has passed even with few events", async () => {
    const session = await seedSession();
    await seedEvents(session.id, 4);
    const summarizer = new RecordingSummarizer("first take");
    await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 1 },
    );
    summarizer.calls.length = 0;

    // 6 minutes later, 2 new events — interval-triggered.
    clock.advance(6 * 60 * 1000);
    const result = await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      { sessionId: session.id, currentSeq: 3 },
    );
    expect(result.kind).toBe("updated");
    expect(summarizer.calls).toHaveLength(1);
  });

  it("returns 'no-session' when the session id is unknown", async () => {
    const summarizer = new RecordingSummarizer("ignored");
    const result = await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      DEFAULT_SUMMARY_CONFIG,
      {
        sessionId: "00000000-0000-7000-8000-deadbeef0000" as never,
        currentSeq: 0,
      },
    );
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no-session");
    expect(summarizer.calls).toHaveLength(0);
  });

  it("passes only the trailing window into the summarizer prompt", async () => {
    const session = await seedSession();
    await seedEvents(session.id, 50);
    const summarizer = new RecordingSummarizer("ok");
    await maybeUpdateSessionSummary(
      { sessions, events, summarizer, clock },
      { ...DEFAULT_SUMMARY_CONFIG, windowSize: 10 },
      { sessionId: session.id, currentSeq: 49 },
    );
    const passed = summarizer.calls[0]!.events;
    expect(passed.length).toBe(10);
    expect(passed[0]!.seq).toBe(40);
    expect(passed[passed.length - 1]!.seq).toBe(49);
  });
});
