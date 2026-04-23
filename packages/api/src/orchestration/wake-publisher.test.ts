import { describe, it, expect, beforeEach } from "bun:test";
import { StringCodec } from "nats";
import {
  InMemoryAgentRepository,
  type Agent,
} from "@x1agent/domain-agents";
import { InMemorySessionRepository } from "@x1agent/domain-sessions";
import {
  publishStateChangeWake,
  formatStateChangeWakeText,
} from "./wake-publisher.js";

/**
 * Minimal NATS fake: records every publish. The wake publisher only
 * uses `publish`; nothing else on the NatsConnection interface is
 * exercised, so we pass through a subset with an `as never` cast in
 * the deps rather than reaching for a full mock library.
 */
class FakeNats {
  published: Array<{ subject: string; body: unknown }> = [];
  publish(subject: string, data: Uint8Array) {
    const sc = StringCodec();
    this.published.push({ subject, body: JSON.parse(sc.decode(data)) });
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
    expect(body.payload.text as string).toContain("post-mortem");
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
    expect(t).toContain("does not need a response");
    expect(t).toContain("driverless");
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
    expect(t).toContain("needs_response=true");
    expect(t).toContain("waiting for you to inject_message");
    expect(t).toContain("post-mortem");
  });
});

describe("formatStateChangeWakeText", () => {
  it("complete variant references read_session and CLAUDE.md", () => {
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
    expect(t).toContain("read_session");
    expect(t).toContain("CLAUDE.md");
    expect(t).toContain("driverless");
  });

  it("failed variant names post-mortem discipline", () => {
    const t = formatStateChangeWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "child-worker",
      terminalStatus: "failed",
      completedAt: new Date("2026-04-23T15:00:00Z"),
      errorMessage: "OOMKilled",
    });
    expect(t).toContain("failed");
    expect(t).toContain("OOMKilled");
    expect(t).toContain("post-mortem");
    expect(t).toContain("Needs human review");
  });
});
