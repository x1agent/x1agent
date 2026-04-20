import { describe, it, expect, beforeEach } from "bun:test";
import { UserId, WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import { CronSchedule } from "../domain/cron-schedule.js";
import { RuntimeType } from "../domain/runtime.js";
import {
  AgentNotFoundError,
  AgentSlugTakenError,
} from "../domain/agent.js";
import { createAgent } from "./create-agent.js";
import { updateAgent } from "./update-agent.js";
import { deleteAgent } from "./delete-agent.js";
import { listAgents } from "./list-agents.js";
import {
  AllowAllAdmin,
  DenyAdmin,
  InMemoryAgentRepository,
} from "./fakes.js";

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const ACTOR = UserId(uuid(1));
const WS = WorkspaceId(uuid(2));

let agents: InMemoryAgentRepository;

beforeEach(() => {
  agents = new InMemoryAgentRepository();
});

describe("createAgent", () => {
  it("creates an agent with defaults", async () => {
    const a = await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("heartbeat"),
        name: "Heartbeat",
        runtimeType: RuntimeType("claude_code"),
      },
    );
    expect(a.name).toBe("Heartbeat");
    expect(a.runtimeType).toBe("claude_code");
    expect(a.systemPrompt).toBe("");
    expect(a.heartbeatMd).toBe("");
    expect(a.schedule).toBeNull();
    expect(a.isActive).toBe(true);
  });

  it("persists schedule when provided", async () => {
    const a = await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("hourly"),
        name: "Hourly",
        runtimeType: RuntimeType("claude_code"),
        schedule: CronSchedule("@hourly"),
      },
    );
    expect(a.schedule).toBe(CronSchedule("@hourly"));
  });

  it("requires admin", async () => {
    await expect(
      createAgent(
        { agents, adminGuard: new DenyAdmin() },
        {
          actor: ACTOR,
          workspaceId: WS,
          slug: WorkspaceSlug("xray"),
          name: "X",
          runtimeType: RuntimeType("claude_code"),
        },
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects duplicate slug within the same workspace", async () => {
    await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("same"),
        name: "First",
        runtimeType: RuntimeType("claude_code"),
      },
    );
    await expect(
      createAgent(
        { agents, adminGuard: new AllowAllAdmin() },
        {
          actor: ACTOR,
          workspaceId: WS,
          slug: WorkspaceSlug("same"),
          name: "Second",
          runtimeType: RuntimeType("claude_code"),
        },
      ),
    ).rejects.toBeInstanceOf(AgentSlugTakenError);
  });
});

describe("updateAgent", () => {
  it("patches provided fields", async () => {
    const a = await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("alpha"),
        name: "First",
        runtimeType: RuntimeType("claude_code"),
      },
    );
    const updated = await updateAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      ACTOR,
      a.id,
      {
        name: "Renamed",
        heartbeatMd: "## Todo\n- check things",
        schedule: CronSchedule("@daily"),
      },
    );
    expect(updated.name).toBe("Renamed");
    expect(updated.heartbeatMd).toContain("check things");
    expect(updated.schedule).toBe(CronSchedule("@daily"));
  });

  it("errors on unknown id", async () => {
    await expect(
      updateAgent(
        { agents, adminGuard: new AllowAllAdmin() },
        ACTOR,
        "no-such-agent" as ReturnType<typeof import("../domain/agent.js").AgentId>,
        { name: "x" },
      ),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });
});

describe("deleteAgent", () => {
  it("removes the agent", async () => {
    const a = await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("alpha"),
        name: "X",
        runtimeType: RuntimeType("claude_code"),
      },
    );
    await deleteAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      ACTOR,
      a.id,
    );
    expect(await agents.findById(a.id)).toBeNull();
  });
});

describe("listAgents", () => {
  it("returns only agents for the given workspace", async () => {
    await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("alpha"),
        name: "A",
        runtimeType: RuntimeType("claude_code"),
      },
    );
    const otherWs = WorkspaceId(uuid(99));
    await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: otherWs,
        slug: WorkspaceSlug("beta"),
        name: "B",
        runtimeType: RuntimeType("claude_code"),
      },
    );
    const rows = await listAgents(agents, ACTOR, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("A");
  });
});

describe("listScheduled", () => {
  it("returns only active agents with a schedule", async () => {
    await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("scheduled"),
        name: "S",
        runtimeType: RuntimeType("claude_code"),
        schedule: CronSchedule("@hourly"),
      },
    );
    await createAgent(
      { agents, adminGuard: new AllowAllAdmin() },
      {
        actor: ACTOR,
        workspaceId: WS,
        slug: WorkspaceSlug("manual"),
        name: "M",
        runtimeType: RuntimeType("claude_code"),
      },
    );
    const rows = await agents.listScheduled();
    expect(rows.map((r) => r.slug)).toEqual([
      WorkspaceSlug("scheduled"),
    ]);
  });
});
