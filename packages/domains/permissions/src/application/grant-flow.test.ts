import { describe, it, expect, beforeEach } from "bun:test";
import { DomainError, UserId, WorkspaceId } from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import { GrantType, type GrantId } from "../domain/grant.js";

async function expectCode(
  p: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await p;
    throw new Error(`expected rejection with code ${code}`);
  } catch (err) {
    if (!(err instanceof DomainError))
      throw new Error(`expected DomainError, got ${String(err)}`);
    expect(err.code).toBe(code);
  }
}
import { SPAWN_GRANT_TYPE } from "../domain/details/spawn.js";
import { TOOL_SCOPE_GRANT_TYPE } from "../domain/details/tool-scope.js";
import { createGrant } from "./create-grant.js";
import { revokeGrant } from "./revoke-grant.js";
import { consumeGrant } from "./consume-grant.js";
import { listGrants } from "./list-grants.js";
import { findActiveGrant } from "./lookup-active.js";
import {
  AllowAllAdmin,
  DenyAdmin,
  InMemoryPermissionGrantRepository,
  agentSubject,
  userSubject,
} from "./fakes.js";

const ws = WorkspaceId("019da258-70a0-7efa-98a1-47cdc5f9e000");
const otherWs = WorkspaceId("019da258-70a0-7efa-98a1-47cdc5f9e999");
const actor = UserId("019da258-70a3-7ea0-b83e-6b12c465e7c9");
const agent = AgentId("019da258-70a0-7efa-98a1-47cdc5f9e111");
const child = AgentId("019da258-70a0-7efa-98a1-47cdc5f9e222");
const session = "019da258-70a0-7efa-98a1-47cdc5f9e333";

let grants: InMemoryPermissionGrantRepository;
const deps = () => ({ grants, adminGuard: new AllowAllAdmin() });

beforeEach(() => {
  grants = new InMemoryPermissionGrantRepository();
});

describe("createGrant", () => {
  it("inserts a persistent spawn grant with validated details", async () => {
    const out = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: "orchestrator default",
    });
    expect(out.details).toEqual({ child_agent_id: child });
    expect(out.scope).toBe("persistent");
    expect(out.grantedByUserId).toBe(actor);
    expect(grants.rows).toHaveLength(1);
  });

  it("rejects details shape mismatches", async () => {
    await expectCode(
      createGrant(deps(), {
        actor,
        workspaceId: ws,
        subject: agentSubject(agent),
        grantType: GrantType(SPAWN_GRANT_TYPE),
        details: { wrong_field: child },
        scope: "persistent",
        sessionId: null,
        reason: null,
      }),
      "invalid_grant_shape",
    );
  });

  it("rejects session scope without session_id", async () => {
    await expectCode(
      createGrant(deps(), {
        actor,
        workspaceId: ws,
        subject: agentSubject(agent),
        grantType: GrantType(SPAWN_GRANT_TYPE),
        details: { child_agent_id: child },
        scope: "session",
        sessionId: null,
        reason: null,
      }),
      "session_scope_requires_session_id",
    );
  });

  it("rejects non-session scope with a session_id", async () => {
    await expectCode(
      createGrant(deps(), {
        actor,
        workspaceId: ws,
        subject: agentSubject(agent),
        grantType: GrantType(SPAWN_GRANT_TYPE),
        details: { child_agent_id: child },
        scope: "persistent",
        sessionId: session as never,
        reason: null,
      }),
      "non_session_scope_rejects_session_id",
    );
  });

  it("rejects non-admins", async () => {
    await expectCode(
      createGrant(
        { grants, adminGuard: new DenyAdmin() },
        {
          actor,
          workspaceId: ws,
          subject: agentSubject(agent),
          grantType: GrantType(SPAWN_GRANT_TYPE),
          details: { child_agent_id: child },
          scope: "persistent",
          sessionId: null,
          reason: null,
        },
      ),
      "admin_denied",
    );
  });
});

describe("revokeGrant", () => {
  it("soft-deletes an active grant", async () => {
    const g = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    const out = await revokeGrant(deps(), {
      actor,
      workspaceId: ws,
      grantId: g.id,
    });
    expect(out.revokedAt).not.toBeNull();
  });

  it("is idempotent", async () => {
    const g = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    const first = await revokeGrant(deps(), {
      actor,
      workspaceId: ws,
      grantId: g.id,
    });
    const second = await revokeGrant(deps(), {
      actor,
      workspaceId: ws,
      grantId: g.id,
    });
    expect(first.revokedAt).toEqual(second.revokedAt);
  });

  it("rejects cross-workspace revocation", async () => {
    const g = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    await expectCode(
      revokeGrant(deps(), {
        actor,
        workspaceId: otherWs,
        grantId: g.id,
      }),
      "grant_wrong_workspace",
    );
  });

  it("rejects unknown grant ids", async () => {
    await expectCode(
      revokeGrant(deps(), {
        actor,
        workspaceId: ws,
        grantId: "00000000-0000-0000-0000-000000000000" as GrantId,
      }),
      "grant_not_found",
    );
  });
});

describe("consumeGrant", () => {
  it("sets consumed_at atomically on first call", async () => {
    const g = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: userSubject(actor),
      grantType: GrantType(TOOL_SCOPE_GRANT_TYPE),
      details: { scope: "git.write" },
      scope: "once",
      sessionId: null,
      reason: null,
    });
    const first = await consumeGrant({ grants }, g.id);
    expect(first?.consumedAt).not.toBeNull();
    const second = await consumeGrant({ grants }, g.id);
    expect(second).toBeNull();
  });

  it("returns null for revoked grants", async () => {
    const g = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: userSubject(actor),
      grantType: GrantType(TOOL_SCOPE_GRANT_TYPE),
      details: { scope: "git.write" },
      scope: "once",
      sessionId: null,
      reason: null,
    });
    await revokeGrant(deps(), { actor, workspaceId: ws, grantId: g.id });
    const out = await consumeGrant({ grants }, g.id);
    expect(out).toBeNull();
  });
});

describe("listGrants", () => {
  it("scopes by workspace + subject + type", async () => {
    await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: userSubject(actor),
      grantType: GrantType(TOOL_SCOPE_GRANT_TYPE),
      details: { scope: "git.write" },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });

    const spawnOnly = await listGrants(deps(), {
      actor,
      workspaceId: ws,
      grantType: GrantType(SPAWN_GRANT_TYPE),
    });
    expect(spawnOnly).toHaveLength(1);
    expect(spawnOnly[0]!.grantType).toBe(GrantType(SPAWN_GRANT_TYPE));
  });

  it("excludes revoked by default, includes when asked", async () => {
    const g = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    await revokeGrant(deps(), { actor, workspaceId: ws, grantId: g.id });

    const live = await listGrants(deps(), { actor, workspaceId: ws });
    expect(live).toHaveLength(0);

    const all = await listGrants(deps(), {
      actor,
      workspaceId: ws,
      includeRevoked: true,
    });
    expect(all).toHaveLength(1);
  });
});

describe("findActiveGrant", () => {
  it("returns null when no match", async () => {
    const out = await findActiveGrant(
      { grants },
      {
        workspaceId: ws,
        subject: agentSubject(agent),
        grantType: GrantType(SPAWN_GRANT_TYPE),
      },
    );
    expect(out).toBeNull();
  });

  it("returns the active grant", async () => {
    await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    const out = await findActiveGrant(
      { grants },
      {
        workspaceId: ws,
        subject: agentSubject(agent),
        grantType: GrantType(SPAWN_GRANT_TYPE),
      },
    );
    expect(out?.details).toEqual({ child_agent_id: child });
  });

  it("filters by details predicate", async () => {
    const otherChild = AgentId("019da258-70a0-7efa-98a1-47cdc5f9eaaa");
    await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: otherChild },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });

    const out = await findActiveGrant(
      { grants },
      {
        workspaceId: ws,
        subject: agentSubject(agent),
        grantType: GrantType(SPAWN_GRANT_TYPE),
        matches: (d) => d["child_agent_id"] === otherChild,
      },
    );
    expect(out?.details).toEqual({ child_agent_id: otherChild });
  });

  it("skips revoked + consumed grants", async () => {
    const g = await createGrant(deps(), {
      actor,
      workspaceId: ws,
      subject: agentSubject(agent),
      grantType: GrantType(SPAWN_GRANT_TYPE),
      details: { child_agent_id: child },
      scope: "persistent",
      sessionId: null,
      reason: null,
    });
    await revokeGrant(deps(), { actor, workspaceId: ws, grantId: g.id });

    const out = await findActiveGrant(
      { grants },
      {
        workspaceId: ws,
        subject: agentSubject(agent),
        grantType: GrantType(SPAWN_GRANT_TYPE),
      },
    );
    expect(out).toBeNull();
  });
});
