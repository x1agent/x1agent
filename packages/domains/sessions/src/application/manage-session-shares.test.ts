import { describe, it, expect, beforeEach } from "bun:test";
import { UserId, WorkspaceId } from "@x1agent/kernel";
const AgentId = (s: string) => s as unknown as never;
import {
  shareSession,
  unshareSession,
  canReadSession,
  canWriteSession,
  NotSessionOwnerError,
  SessionNotFoundForShareError,
} from "./manage-session-shares.js";
import {
  CannotShareWithSelfError,
  InvalidShareRoleError,
} from "../domain/share.js";
import type { Session } from "../domain/session.js";
import { SessionId } from "../domain/session.js";

class FakeSessionRepo {
  private byId = new Map<string, Session>();
  add(s: Session) {
    this.byId.set(s.id, s);
  }
  async findById(id: string) {
    return this.byId.get(id) ?? null;
  }
  // Other SessionRepository methods aren't exercised here; the share
  // service only calls findById.
}

class FakeShareRepo {
  private rows = new Map<string, { sessionId: string; userId: string; role: string }>();
  async upsert(input: {
    sessionId: string;
    userId: string;
    role: string;
    sharedBy: string;
  }) {
    const key = `${input.sessionId}:${input.userId}`;
    const row = {
      ...input,
      id: key,
      createdAt: new Date(),
    };
    this.rows.set(key, row);
    return {
      id: row.id as never,
      sessionId: row.sessionId as never,
      userId: row.userId as never,
      role: row.role as "viewer" | "collaborator",
      sharedBy: row.sharedBy as never,
      createdAt: row.createdAt,
    };
  }
  async removeForUser(sessionId: string, userId: string) {
    this.rows.delete(`${sessionId}:${userId}`);
  }
  async findForUser(sessionId: string, userId: string) {
    const r = this.rows.get(`${sessionId}:${userId}`);
    if (!r) return null;
    return {
      id: r.sessionId + ":" + r.userId as never,
      sessionId: r.sessionId as never,
      userId: r.userId as never,
      role: r.role as "viewer" | "collaborator",
      sharedBy: "" as never,
      createdAt: new Date(),
    };
  }
  // listForSession + listForUser + remove are not exercised here.
  async remove() {}
  async listForSession() { return []; }
  async listForUser() { return []; }
}

const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const BOB = UserId("00000000-0000-7000-8000-00000000b0b0");
const CAROL = UserId("00000000-0000-7000-8000-00000000ca40");

function makeSession(ownerId: ReturnType<typeof UserId>): Session {
  return {
    id: SessionId("00000000-0000-7000-8000-000000000005"),
    agentId: AgentId("00000000-0000-7000-8000-0000000000a1"),
    workspaceId: WorkspaceId("00000000-0000-7000-8000-0000000000ff"),
    triggeredBy: "user",
    triggeredByUserId: ownerId,
    triggeredAt: new Date(),
    completedAt: null,
    errorMessage: null,
    status: "running",
    resumedFromSessionId: null,
    parentSessionId: null,
    expectQuietFor: null,
  } as Session;
}

let sessions: FakeSessionRepo;
let shares: FakeShareRepo;
let deps: { sessions: FakeSessionRepo; shares: FakeShareRepo };

beforeEach(() => {
  sessions = new FakeSessionRepo();
  shares = new FakeShareRepo();
  deps = { sessions, shares } as never;
});

describe("shareSession", () => {
  it("owner can share with another user", async () => {
    sessions.add(makeSession(ALICE));
    const share = await shareSession(deps as never, {
      sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
      granteeUserId: BOB,
      role: "viewer",
      actor: ALICE,
      actorIsWorkspaceAdmin: false,
    });
    expect(share.userId).toBe(BOB);
    expect(share.role).toBe("viewer");
  });

  it("non-owner non-admin gets NotSessionOwnerError", async () => {
    sessions.add(makeSession(ALICE));
    await expect(
      shareSession(deps as never, {
        sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
        granteeUserId: CAROL,
        role: "viewer",
        actor: BOB,
        actorIsWorkspaceAdmin: false,
      }),
    ).rejects.toBeInstanceOf(NotSessionOwnerError);
  });

  it("workspace admin (non-owner) is allowed", async () => {
    sessions.add(makeSession(ALICE));
    const share = await shareSession(deps as never, {
      sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
      granteeUserId: CAROL,
      role: "collaborator",
      actor: BOB,
      actorIsWorkspaceAdmin: true,
    });
    expect(share.sharedBy).toBe(BOB);
  });

  it("rejects sharing with self", async () => {
    sessions.add(makeSession(ALICE));
    await expect(
      shareSession(deps as never, {
        sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
        granteeUserId: ALICE,
        role: "viewer",
        actor: ALICE,
        actorIsWorkspaceAdmin: false,
      }),
    ).rejects.toBeInstanceOf(CannotShareWithSelfError);
  });

  it("rejects an invalid role", async () => {
    sessions.add(makeSession(ALICE));
    await expect(
      shareSession(deps as never, {
        sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
        granteeUserId: BOB,
        role: "admin",
        actor: ALICE,
        actorIsWorkspaceAdmin: false,
      }),
    ).rejects.toBeInstanceOf(InvalidShareRoleError);
  });

  it("rejects with SessionNotFoundForShareError when session is missing", async () => {
    await expect(
      shareSession(deps as never, {
        sessionId: SessionId("00000000-0000-7000-8000-00000000ffff"),
        granteeUserId: BOB,
        role: "viewer",
        actor: ALICE,
        actorIsWorkspaceAdmin: false,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundForShareError);
  });
});

describe("canReadSession + canWriteSession", () => {
  it("owner can read + write", async () => {
    sessions.add(makeSession(ALICE));
    const r = await canReadSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), ALICE);
    expect(r.ok).toBe(true);
    expect(await canWriteSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), ALICE)).toBe(true);
  });

  it("viewer can read, not write", async () => {
    sessions.add(makeSession(ALICE));
    await shareSession(deps as never, {
      sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
      granteeUserId: BOB,
      role: "viewer",
      actor: ALICE,
      actorIsWorkspaceAdmin: false,
    });
    const r = await canReadSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), BOB);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe("share");
    expect(await canWriteSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), BOB)).toBe(false);
  });

  it("collaborator can read + write", async () => {
    sessions.add(makeSession(ALICE));
    await shareSession(deps as never, {
      sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
      granteeUserId: BOB,
      role: "collaborator",
      actor: ALICE,
      actorIsWorkspaceAdmin: false,
    });
    expect(await canWriteSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), BOB)).toBe(true);
  });

  it("unrelated user can do neither", async () => {
    sessions.add(makeSession(ALICE));
    const r = await canReadSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), CAROL);
    expect(r.ok).toBe(false);
    expect(await canWriteSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), CAROL)).toBe(false);
  });
});

describe("unshareSession", () => {
  it("owner can revoke a share", async () => {
    sessions.add(makeSession(ALICE));
    await shareSession(deps as never, {
      sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
      granteeUserId: BOB,
      role: "viewer",
      actor: ALICE,
      actorIsWorkspaceAdmin: false,
    });
    await unshareSession(deps as never, {
      sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
      granteeUserId: BOB,
      actor: ALICE,
      actorIsWorkspaceAdmin: false,
    });
    const r = await canReadSession(deps as never,
      SessionId("00000000-0000-7000-8000-000000000005"), BOB);
    expect(r.ok).toBe(false);
  });

  it("non-owner non-admin cannot revoke", async () => {
    sessions.add(makeSession(ALICE));
    await shareSession(deps as never, {
      sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
      granteeUserId: BOB,
      role: "viewer",
      actor: ALICE,
      actorIsWorkspaceAdmin: false,
    });
    await expect(
      unshareSession(deps as never, {
        sessionId: SessionId("00000000-0000-7000-8000-000000000005"),
        granteeUserId: BOB,
        actor: CAROL,
        actorIsWorkspaceAdmin: false,
      }),
    ).rejects.toBeInstanceOf(NotSessionOwnerError);
  });
});
