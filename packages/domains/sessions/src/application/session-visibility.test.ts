import { describe, it, expect } from "bun:test";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import {
  pickSessionListMode,
  resolveSessionVisibility,
} from "./session-visibility.js";
import { SessionId } from "../domain/session.js";

// ─── Fakes ────────────────────────────────────────────────────────────

class PlatformAdminYes {
  async isPlatformAdmin() {
    return true;
  }
}
class PlatformAdminNo {
  async isPlatformAdmin() {
    return false;
  }
}

class FakeShares {
  private rows = new Set<string>();
  grant(sessionId: string, userId: string) {
    this.rows.add(`${sessionId}:${userId}`);
  }
  async findForUser(sessionId: string, userId: string) {
    if (!this.rows.has(`${sessionId}:${userId}`)) return null;
    return {
      id: "share" as never,
      sessionId: sessionId as never,
      userId: userId as never,
      role: "viewer" as const,
      sharedBy: "" as never,
      createdAt: new Date(),
    };
  }
  async upsert() {
    throw new Error("not used");
  }
  async remove() {}
  async removeForUser() {}
  async listForSession() {
    return [];
  }
  async listForUser() {
    return [];
  }
}

const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const BOB = UserId("00000000-0000-7000-8000-00000000b0b0");
const CAROL = UserId("00000000-0000-7000-8000-00000000ca40");
const WS_A = WorkspaceId("00000000-0000-7000-8000-0000000000a1");

const SESSION = {
  id: SessionId("00000000-0000-7000-8000-000000000001"),
  triggeredByUserId: ALICE,
  agentId: "00000000-0000-7000-8000-0000000000a9" as never,
};

describe("resolveSessionVisibility", () => {
  it("owner sees their own session (no admin/share check needed)", async () => {
    const r = await resolveSessionVisibility({}, ALICE, SESSION, WS_A);
    expect(r).toEqual({ visible: true, reason: "owner" });
  });

  it("platform admin sees a session they don't own and weren't shared", async () => {
    const r = await resolveSessionVisibility(
      { platformAdminGuard: new PlatformAdminYes() },
      BOB,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "platform_admin" });
  });

  it("workspace admin does NOT bypass — needs ownership or an explicit share", async () => {
    // This is the regression: workspace admin used to bypass visibility,
    // which leaked every user's sessions to anyone with the admin role
    // in the workspace. Platform admin is the only deployment-wide
    // bypass; workspace admin must look at the same filter as everyone
    // else.
    const r = await resolveSessionVisibility(
      {
        platformAdminGuard: new PlatformAdminNo(),
        shares: new FakeShares() as never,
      },
      BOB,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: false });
  });

  it("non-owner, non-admin, no share → invisible", async () => {
    const r = await resolveSessionVisibility(
      { platformAdminGuard: new PlatformAdminNo(), shares: new FakeShares() as never },
      CAROL,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: false });
  });

  it("non-owner, non-admin, share granted → visible via user_share", async () => {
    const shares = new FakeShares();
    shares.grant(SESSION.id, BOB);
    const r = await resolveSessionVisibility(
      { platformAdminGuard: new PlatformAdminNo(), shares: shares as never },
      BOB,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "user_share" });
  });

  it("missing shares repo + non-owner + non-platform-admin → invisible (degrades safely)", async () => {
    const r = await resolveSessionVisibility({}, CAROL, SESSION, WS_A);
    expect(r).toEqual({ visible: false });
  });

  it("agent-collaborate resolver returns true → visible via agent_collaborator (the open-by-default workspace tier + explicit grants both flow through here)", async () => {
    const r = await resolveSessionVisibility(
      {
        platformAdminGuard: new PlatformAdminNo(),
        shares: new FakeShares() as never,
        agentCollaborateResolver: async () => true,
      },
      BOB,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "agent_collaborator" });
  });

  it("agent-collaborate resolver returns false → falls through to invisible", async () => {
    const r = await resolveSessionVisibility(
      {
        platformAdminGuard: new PlatformAdminNo(),
        shares: new FakeShares() as never,
        agentCollaborateResolver: async () => false,
      },
      CAROL,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: false });
  });

  it("share grant wins before the agent-collaborate resolver is consulted (avoids redundant agent lookup)", async () => {
    const shares = new FakeShares();
    shares.grant(SESSION.id, BOB);
    let resolverCalls = 0;
    const r = await resolveSessionVisibility(
      {
        platformAdminGuard: new PlatformAdminNo(),
        shares: shares as never,
        agentCollaborateResolver: async () => {
          resolverCalls++;
          return true;
        },
      },
      BOB,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "user_share" });
    expect(resolverCalls).toBe(0);
  });

  it("owner takes precedence over share — no platform-admin lookup performed", async () => {
    let called = false;
    const r = await resolveSessionVisibility(
      {
        platformAdminGuard: {
          async isPlatformAdmin() {
            called = true;
            return true;
          },
        },
      },
      ALICE,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "owner" });
    expect(called).toBe(false);
  });
});

describe("pickSessionListMode", () => {
  it("platform admin → mode 'all' (unfiltered query)", async () => {
    const m = await pickSessionListMode(
      { platformAdminGuard: new PlatformAdminYes() },
      ALICE,
      WS_A,
    );
    expect(m).toEqual({ mode: "all" });
  });

  it("workspace admin / regular user → mode 'user' carrying the actor's userId", async () => {
    const m = await pickSessionListMode(
      { platformAdminGuard: new PlatformAdminNo() },
      BOB,
      WS_A,
    );
    expect(m).toEqual({ mode: "user", userId: BOB });
  });

  it("missing platformAdminGuard → mode 'user' (safe default)", async () => {
    const m = await pickSessionListMode({}, BOB, WS_A);
    expect(m).toEqual({ mode: "user", userId: BOB });
  });
});
