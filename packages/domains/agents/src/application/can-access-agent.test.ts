import { describe, it, expect, beforeEach } from "bun:test";
import { UserId, WorkspaceId, makeSubject } from "@x1agent/kernel";
import { resolveAgentAccess, userHasAgentVerb } from "./can-access-agent.js";
import type { AccessContext } from "./can-access-agent.js";
import type { Agent, AgentId } from "../domain/agent.js";
import type { AgentVerb, AgentGrant } from "../domain/grant.js";
import { AgentId as AgentIdMk } from "../domain/agent.js";
import { AgentGrantId } from "../domain/grant.js";
import { RuntimeType } from "../domain/runtime.js";
import { AgentKind } from "../domain/kind.js";
import { WorkspaceSlug } from "@x1agent/kernel";

class FakeAgents {
  private byId = new Map<string, Agent>();
  add(a: Agent) {
    this.byId.set(a.id, a);
  }
  async findById(id: AgentId) {
    return this.byId.get(id) ?? null;
  }
}

class FakeGrants {
  private rows: Array<{
    agentId: string;
    subject: { kind: string; id: string | null };
    verb: AgentVerb;
  }> = [];
  add(
    agentId: string,
    subjectKind: string,
    subjectId: string | null,
    verb: AgentVerb,
  ) {
    this.rows.push({
      agentId,
      subject: { kind: subjectKind, id: subjectId },
      verb,
    });
  }
  async listVerbsForResolver(input: {
    agentId: AgentId;
    userId: UserId;
    userGroupIds: readonly string[];
    userIsWorkspaceMember: boolean;
  }) {
    const set = new Set<AgentVerb>();
    for (const r of this.rows) {
      if (r.agentId !== input.agentId) continue;
      if (
        (r.subject.kind === "user" && r.subject.id === input.userId) ||
        (r.subject.kind === "group" &&
          r.subject.id !== null &&
          input.userGroupIds.includes(r.subject.id)) ||
        (r.subject.kind === "workspace" && input.userIsWorkspaceMember) ||
        r.subject.kind === "public"
      ) {
        set.add(r.verb);
      }
    }
    return set;
  }
  // Unused stubs to satisfy structural types if needed
  async upsert() {
    return null as unknown as AgentGrant;
  }
  async remove() {}
  async removeForSubject() {}
  async listForAgent() {
    return [];
  }
}

const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const BOB = UserId("00000000-0000-7000-8000-00000000b0b0");
const AGT = AgentIdMk("00000000-0000-7000-8000-0000000000a1");

function makeAgent(opts: Partial<Agent> = {}): Agent {
  return {
    id: AGT,
    workspaceId: WorkspaceId("00000000-0000-7000-8000-0000000000ff"),
    slug: WorkspaceSlug("agent"),
    name: "agent",
    runtimeType: RuntimeType("claude_code"),
    kind: AgentKind("worker"),
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    isActive: true,
    imageId: null,
    model: null,
    ownerUserId: ALICE,
    visibility: "workspace",
    createdBy: ALICE,
    scheduledRunAsUserId: ALICE,
    idleTimeoutSeconds: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSchedulerTickAt: null,
    ...opts,
    skillSources: opts.skillSources ?? [],
  };
}

let agents: FakeAgents;
let grants: FakeGrants;
let deps: { agents: FakeAgents; grants: FakeGrants };
const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  userGroupIds: [],
  isWorkspaceMember: true,
  isWorkspaceAdmin: false,
  ...over,
});

beforeEach(() => {
  agents = new FakeAgents();
  grants = new FakeGrants();
  deps = { agents, grants } as never;
});

describe("resolveAgentAccess", () => {
  it("owner gets all three verbs", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE }));
    const r = await resolveAgentAccess(deps as never, AGT, ALICE, ctx());
    expect(r).toMatchObject({
      canView: true,
      canInvoke: true,
      canEdit: true,
      via: "owner",
    });
  });

  it("workspace admin sees all even on a private agent", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "private" }));
    const r = await resolveAgentAccess(
      deps as never,
      AGT,
      BOB,
      ctx({ isWorkspaceAdmin: true }),
    );
    expect(r).toMatchObject({
      canView: true,
      canInvoke: true,
      canEdit: true,
      via: "admin",
    });
  });

  it("private agent — non-owner non-admin sees nothing", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "private" }));
    const r = await resolveAgentAccess(deps as never, AGT, BOB, ctx());
    expect(r).toMatchObject({
      canView: false,
      canInvoke: false,
      canEdit: false,
      via: "denied",
    });
  });

  it("workspace-visible agent — any member can view + invoke; cannot edit", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "workspace" }));
    const r = await resolveAgentAccess(deps as never, AGT, BOB, ctx());
    expect(r).toMatchObject({
      canView: true,
      canInvoke: true,
      canEdit: false,
      via: "visibility_workspace",
    });
  });

  it("via_grants — explicit user grant for invoke promotes view too", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "via_grants" }));
    grants.add(AGT, "user", BOB, "invoke");
    const r = await resolveAgentAccess(
      deps as never,
      AGT,
      BOB,
      ctx({ isWorkspaceMember: false }),
    );
    expect(r).toMatchObject({
      canView: true,
      canInvoke: true,
      canEdit: false,
      via: "grant",
    });
  });

  it("via_grants — group grant matches when user is in that group", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "via_grants" }));
    grants.add(AGT, "group", "g-marketing", "invoke");
    const r = await resolveAgentAccess(
      deps as never,
      AGT,
      BOB,
      ctx({ userGroupIds: ["g-marketing"] }),
    );
    expect(r.canInvoke).toBe(true);
  });

  it("via_grants — group grant does NOT match when user isn't in the group", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "via_grants" }));
    grants.add(AGT, "group", "g-marketing", "invoke");
    const r = await resolveAgentAccess(
      deps as never,
      AGT,
      BOB,
      ctx({ userGroupIds: ["g-engineering"] }),
    );
    expect(r.canInvoke).toBe(false);
  });

  it("via_grants — public grant lets anyone in", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "via_grants" }));
    grants.add(AGT, "public", null, "view");
    const r = await resolveAgentAccess(
      deps as never,
      AGT,
      BOB,
      ctx({ isWorkspaceMember: false }),
    );
    expect(r.canView).toBe(true);
    expect(r.canInvoke).toBe(false);
  });

  it("edit verb is owner/admin only — visibility never grants edit", async () => {
    agents.add(makeAgent({ ownerUserId: ALICE, visibility: "workspace" }));
    expect(await userHasAgentVerb(deps as never, AGT, BOB, ctx(), "edit")).toBe(
      false,
    );
  });

  it("missing agent returns denied snapshot with agent=null", async () => {
    const r = await resolveAgentAccess(deps as never, AGT, ALICE, ctx());
    expect(r.agent).toBeNull();
    expect(r.canView).toBe(false);
  });

  it("makeSubject still rejects bad shapes (smoke test for kernel)", () => {
    expect(() => makeSubject("user", null)).toThrow();
    expect(() => makeSubject("public", "x")).toThrow();
  });
});
