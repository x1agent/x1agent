import { describe, it, expect } from "bun:test";
import { UserId, WorkspaceId, DomainError } from "@x1agent/kernel";
import {
  pickSessionListMode,
  resolveSessionVisibility,
} from "./session-visibility.js";
import { SessionId } from "../domain/session.js";

// ─── Fakes ────────────────────────────────────────────────────────────
//
// The visibility helper depends on an AdminGuard and (optionally) a
// SessionShareRepository. We only need the methods it actually calls.

class AdminGuardYes {
  async assertAdmin() {
    // workspace admin / owner — passes
  }
  async assertMember() {
    // any member — passes
  }
}

class AdminGuardNo {
  async assertAdmin() {
    throw new (class extends DomainError {
      readonly code = "admin_denied";
      constructor() {
        super("not admin");
      }
    })();
  }
  async assertMember() {
    // Visibility tests use this guard for non-admin members; they should
    // pass the member check (they're still a member, just not admin).
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
};

describe("resolveSessionVisibility", () => {
  it("owner sees their own session (no admin/share check needed)", async () => {
    const r = await resolveSessionVisibility(
      { adminGuard: new AdminGuardNo() },
      ALICE,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "owner" });
  });

  it("workspace admin sees a session they don't own and weren't shared", async () => {
    const r = await resolveSessionVisibility(
      { adminGuard: new AdminGuardYes() },
      BOB,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "workspace_admin" });
  });

  it("non-owner, non-admin, no share → invisible", async () => {
    const r = await resolveSessionVisibility(
      { adminGuard: new AdminGuardNo(), shares: new FakeShares() },
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
      { adminGuard: new AdminGuardNo(), shares },
      BOB,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: true, reason: "user_share" });
  });

  it("missing shares repo + non-owner + non-admin → invisible (degrades safely)", async () => {
    const r = await resolveSessionVisibility(
      { adminGuard: new AdminGuardNo() },
      CAROL,
      SESSION,
      WS_A,
    );
    expect(r).toEqual({ visible: false });
  });

  it("owner takes precedence over share — no admin lookup performed", async () => {
    // Tracks that the admin guard isn't called when owner check passes.
    // Important: cheapest branch first, so the workspace_sessions list
    // doesn't fire an admin check per row.
    let called = false;
    const r = await resolveSessionVisibility(
      {
        adminGuard: {
          async assertAdmin() {
            called = true;
          },
          async assertMember() {
            called = true;
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
  it("admin → mode 'all' (unfiltered query)", async () => {
    const m = await pickSessionListMode(
      { adminGuard: new AdminGuardYes() },
      ALICE,
      WS_A,
    );
    expect(m).toEqual({ mode: "all" });
  });

  it("non-admin → mode 'user' carrying the actor's userId", async () => {
    const m = await pickSessionListMode(
      { adminGuard: new AdminGuardNo() },
      BOB,
      WS_A,
    );
    expect(m).toEqual({ mode: "user", userId: BOB });
  });
});
