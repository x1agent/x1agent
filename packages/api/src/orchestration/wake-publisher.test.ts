import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StringCodec } from "nats";
import {
  InMemoryAgentRepository,
  type Agent,
} from "@x1agent/domain-agents";
import { InMemorySessionRepository } from "@x1agent/domain-sessions";
import {
  publishStateChangeWake,
  publishWatchdogWake,
  publishMessageWake,
  publishCheckupWake,
  publishHeartbeatWake,
  formatStateChangeWakeText,
} from "./wake-publisher.js";

/**
 * Minimal NATS fake: records every publish on either the core or the
 * JetStream path. The wake publisher only uses `publish` (core) and
 * `jetstream().publish` (JS-aware); nothing else on the NatsConnection
 * interface is exercised, so the test passes a subset with an
 * `as never` cast rather than reaching for a full mock library.
 */
class FakeNats {
  publishedCore: Array<{ subject: string; body: unknown }> = [];
  publishedJs: Array<{
    subject: string;
    body: unknown;
    msgId: string | undefined;
  }> = [];

  publish(subject: string, data: Uint8Array) {
    const sc = StringCodec();
    this.publishedCore.push({ subject, body: JSON.parse(sc.decode(data)) });
  }

  jetstream() {
    return {
      publish: async (
        subject: string,
        data: Uint8Array,
        opts?: { msgID?: string },
      ) => {
        const sc = StringCodec();
        this.publishedJs.push({
          subject,
          body: JSON.parse(sc.decode(data)),
          msgId: opts?.msgID,
        });
        return { stream: "X1_SESSION", seq: this.publishedJs.length };
      },
    };
  }

  // Convenience for tests that don't care which path the message
  // travelled — wake publishers shouldn't mix paths in a single call.
  get published(): Array<{ subject: string; body: unknown }> {
    return [...this.publishedCore, ...this.publishedJs];
  }
}

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const WS = "00000000-0000-7000-8000-00000000aaaa";

let agents: InMemoryAgentRepository;
let sessions: InMemorySessionRepository;
let nats: FakeNats;

async function makeAgent(
  slug: string,
  kind: "worker" | "orchestrator" | "scheduled",
): Promise<Agent> {
  return agents.create({
    workspaceId: WS as never,
    slug: slug as never,
    name: slug,
    runtimeType: "claude_code" as never,
    kind,
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: null,
  });
}

beforeEach(() => {
  agents = new InMemoryAgentRepository();
  sessions = new InMemorySessionRepository();
  nats = new FakeNats();
});

function deps() {
  return { nc: nats as never, sessions, agents };
}

describe("publishStateChangeWake", () => {
  it("no-op when the session has no parent (human-spawned)", async () => {
    const worker = await makeAgent("writer", "worker");
    const child = await sessions.create({
      agentId: worker.id,
      triggeredBy: "user",
      triggeredByUserId: uuid(1) as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });

    await publishStateChangeWake(deps(), child, "complete", new Date(), null);

    expect(nats.published.length).toBe(0);
  });

  it("no-op when the parent session has already terminated", async () => {
    const parentAgent = await makeAgent("orchestrator-a", "orchestrator");
    const childAgent = await makeAgent("worker-a", "worker");
    const parent = await sessions.create({
      agentId: parentAgent.id,
      triggeredBy: "user",
      triggeredByUserId: uuid(1) as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });
    await sessions.updateStatus(parent.id, {
      status: "complete",
      completedAt: new Date(),
    });
    const child = await sessions.create({
      agentId: childAgent.id,
      triggeredBy: "agent",
      triggeredByUserId: null,
      parentSessionId: parent.id,
      parentAgentId: parentAgent.id,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });

    await publishStateChangeWake(deps(), child, "complete", new Date(), null);

    expect(nats.published.length).toBe(0);
  });

  it("no-op when the parent agent is a worker (not orchestrator)", async () => {
    const workerParent = await makeAgent("worker-parent", "worker");
    const child = await makeAgent("child", "worker");
    const parentSession = await sessions.create({
      agentId: workerParent.id,
      triggeredBy: "user",
      triggeredByUserId: uuid(1) as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });
    const childSession = await sessions.create({
      agentId: child.id,
      triggeredBy: "agent",
      triggeredByUserId: null,
      parentSessionId: parentSession.id,
      parentAgentId: workerParent.id,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });

    await publishStateChangeWake(
      deps(),
      childSession,
      "complete",
      new Date(),
      null,
    );

    expect(nats.published.length).toBe(0);
  });

  it("publishes a wake to the parent's input subject on orchestrator parent", async () => {
    const parentAgent = await makeAgent("hirer-orchestrator", "orchestrator");
    const childAgent = await makeAgent("hirer-app", "worker");
    const parent = await sessions.create({
      agentId: parentAgent.id,
      triggeredBy: "user",
      triggeredByUserId: uuid(1) as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });
    const child = await sessions.create({
      agentId: childAgent.id,
      triggeredBy: "agent",
      triggeredByUserId: null,
      parentSessionId: parent.id,
      parentAgentId: parentAgent.id,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });

    await publishStateChangeWake(
      deps(),
      child,
      "complete",
      new Date("2026-04-23T15:00:00Z"),
      null,
    );

    expect(nats.published.length).toBe(1);
    const pub = nats.published[0]!;
    expect(pub.subject).toBe(`x1.session.${parent.id}.input`);
    const body = pub.body as {
      session_id: string;
      type: string;
      payload: Record<string, unknown>;
    };
    expect(body.session_id).toBe(parent.id);
    expect(body.type).toBe("user.message");
    expect(body.payload.kind).toBe("state_change");
    expect(body.payload.from_session_id).toBe(child.id);
    expect(body.payload.from_agent_slug).toBe("hirer-app");
    expect(body.payload.new_status).toBe("complete");
    expect(body.payload.driverless).toBe(true);
    expect(body.payload.source).toBe("platform");
    expect(typeof body.payload.text).toBe("string");
    expect(body.payload.text as string).toContain("hirer-app");
    expect(body.payload.text as string).toContain("complete");
  });

  it("encodes error_message in the wake payload when the child failed", async () => {
    const parentAgent = await makeAgent("orch", "orchestrator");
    const childAgent = await makeAgent("worker", "worker");
    const parent = await sessions.create({
      agentId: parentAgent.id,
      triggeredBy: "user",
      triggeredByUserId: uuid(1) as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });
    const child = await sessions.create({
      agentId: childAgent.id,
      triggeredBy: "agent",
      triggeredByUserId: null,
      parentSessionId: parent.id,
      parentAgentId: parentAgent.id,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });

    await publishStateChangeWake(
      deps(),
      child,
      "failed",
      new Date("2026-04-23T15:00:00Z"),
      "exceeded activeDeadlineSeconds",
    );

    const body = nats.published[0]!.body as {
      payload: Record<string, unknown>;
    };
    expect(body.payload.new_status).toBe("failed");
    expect(body.payload.error_message).toBe("exceeded activeDeadlineSeconds");
    expect(body.payload.text as string).toContain("exceeded activeDeadlineSeconds");
    expect(body.payload.text as string).toContain("failed");
  });
});

describe("formatMessageWakeText", () => {
  it("summary-only (no body, no response needed)", async () => {
    const { formatMessageWakeText } = await import("./wake-publisher.js");
    const t = formatMessageWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "hirer-app",
      summary: "feat/jobs-list ready at abc1234",
      body: null,
      needsResponse: false,
    });
    expect(t).toContain("019d1111");
    expect(t).toContain("hirer-app");
    expect(t).toContain("feat/jobs-list ready at abc1234");
    expect(t).toContain("driverless");
    expect(t).not.toContain("needs_response");
  });

  it("summary + body appended", async () => {
    const { formatMessageWakeText } = await import("./wake-publisher.js");
    const t = formatMessageWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "hirer-app",
      summary: "Ready for review",
      body: "Commit SHA: abc1234\nFiles touched: 12\nTests: all green",
      needsResponse: false,
    });
    expect(t).toContain("Ready for review");
    expect(t).toContain("Commit SHA: abc1234");
    expect(t).toContain("Tests: all green");
  });

  it("needs_response=true surfaces the blocking framing", async () => {
    const { formatMessageWakeText } = await import("./wake-publisher.js");
    const t = formatMessageWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "child",
      summary: "Should I use Postgres or SQLite?",
      body: null,
      needsResponse: true,
    });
    expect(t).toContain("Should I use Postgres or SQLite?");
    expect(t).toContain("needs_response: true");
    expect(t).toContain("driverless");
  });
});

describe("USE_JETSTREAM_PUBLISH path", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env.USE_JETSTREAM_PUBLISH;
    process.env.USE_JETSTREAM_PUBLISH = "true";
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.USE_JETSTREAM_PUBLISH;
    else process.env.USE_JETSTREAM_PUBLISH = savedFlag;
  });

  it("publishStateChangeWake routes through jetstream() with a deterministic msg-id", async () => {
    const parentAgent = await makeAgent("orch", "orchestrator");
    const childAgent = await makeAgent("worker", "worker");
    const parent = await sessions.create({
      agentId: parentAgent.id,
      triggeredBy: "user",
      triggeredByUserId: uuid(1) as never,
      parentSessionId: null,
      parentAgentId: null,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });
    const child = await sessions.create({
      agentId: childAgent.id,
      triggeredBy: "agent",
      triggeredByUserId: null,
      parentSessionId: parent.id,
      parentAgentId: parentAgent.id,
      resumedFromSessionId: null,
      triggeredAt: new Date(),
    });

    await publishStateChangeWake(deps(), child, "complete", new Date(), null);
    // Re-publish the same terminal event: a racing watcher firing
    // twice for the same child + status. Both calls go through the
    // JetStream publish path with identical msg-ids.
    await publishStateChangeWake(deps(), child, "complete", new Date(), null);

    expect(nats.publishedCore.length).toBe(0);
    expect(nats.publishedJs.length).toBe(2);
    expect(nats.publishedJs[0]!.subject).toBe(`x1.session.${parent.id}.input`);
    expect(nats.publishedJs[0]!.msgId).toBe(
      `wake.state_change.${child.id}.complete`,
    );
    expect(nats.publishedJs[1]!.msgId).toBe(nats.publishedJs[0]!.msgId);
  });

  it("publishWatchdogWake encodes (parent, child, attempt) into the msg-id", async () => {
    await publishWatchdogWake(
      nats as never,
      "p-1",
      "c-1",
      "child-slug",
      120,
      3,
    );
    expect(nats.publishedJs.length).toBe(1);
    expect(nats.publishedJs[0]!.msgId).toBe("wake.watchdog.p-1.c-1.3");
  });

  it("publishMessageWake hashes content so retries dedup but distinct messages don't", async () => {
    const opts = {
      childSessionId: "c-1",
      childSlug: "child",
      summary: "hello",
      body: "world",
      needsResponse: false,
    };
    await publishMessageWake(nats as never, "p-1", opts);
    await publishMessageWake(nats as never, "p-1", opts);
    expect(nats.publishedJs[0]!.msgId).toMatch(/^wake\.message\.[0-9a-f]{64}$/);
    expect(nats.publishedJs[0]!.msgId).toBe(nats.publishedJs[1]!.msgId);

    await publishMessageWake(nats as never, "p-1", { ...opts, summary: "diff" });
    expect(nats.publishedJs[2]!.msgId).not.toBe(nats.publishedJs[0]!.msgId);
  });

  it("publishCheckupWake msg-id includes the envelope timestamp", async () => {
    await publishCheckupWake(nats as never, "p-1", []);
    const pub = nats.publishedJs[0]!;
    const ts = (pub.body as { timestamp: string }).timestamp;
    expect(pub.msgId).toBe(`wake.checkup.p-1.${ts}`);
  });

  it("publishHeartbeatWake msg-id includes the envelope timestamp", async () => {
    await publishHeartbeatWake(nats as never, "s-1", "do the thing");
    const pub = nats.publishedJs[0]!;
    const ts = (pub.body as { timestamp: string }).timestamp;
    expect(pub.msgId).toBe(`wake.heartbeat.s-1.${ts}`);
  });
});

describe("formatStateChangeWakeText", () => {
  it("complete variant carries terminal-status fact", () => {
    const t = formatStateChangeWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "child-worker",
      terminalStatus: "complete",
      completedAt: new Date("2026-04-23T15:00:00Z"),
      errorMessage: null,
    });
    expect(t).toContain("complete");
    expect(t).toContain("019d1111");
    expect(t).toContain("child-worker");
    expect(t).toContain("driverless");
    expect(t).toContain("No human is watching");
  });

  it("failed variant includes the error message verbatim", () => {
    const t = formatStateChangeWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "child-worker",
      terminalStatus: "failed",
      completedAt: new Date("2026-04-23T15:00:00Z"),
      errorMessage: "OOMKilled",
    });
    expect(t).toContain("failed");
    expect(t).toContain("OOMKilled");
    expect(t).toContain("driverless");
    expect(t).toContain("No human is watching");
  });
});
