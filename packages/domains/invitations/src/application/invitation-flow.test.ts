import { describe, it, expect, beforeEach } from "bun:test";
import {
  Email,
  FixedClock,
  Role,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
  type Clock,
} from "@x1agent/kernel";
import {
  AllowAllAdmin,
  DenyAdmin,
  FakeWorkspaceReader,
  InMemoryInvitationRepository,
  InMemoryMembershipGrantor,
  SeqTokenGenerator,
} from "./fakes.js";
import { sendInvitation } from "./send-invitation.js";
import { acceptInvitation } from "./accept-invitation.js";
import { revokeInvitation } from "./revoke-invitation.js";
import { listInvitations } from "./list-invitations.js";
import {
  AlreadyMemberError,
  InvitationAlreadyAcceptedError,
  InvitationAlreadyPendingError,
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationRevokedError,
} from "../domain/errors.js";
import { InvitationToken } from "../domain/invitation.js";

const uuidA = "0188f5e1-7e3b-7000-8000-000000000001";
const uuidB = "0188f5e1-7e3b-7000-8000-000000000002";
const uuidC = "0188f5e1-7e3b-7000-8000-000000000003";

const ACTOR = UserId(uuidA);
const BOB = UserId(uuidB);
const WS_ID = WorkspaceId(uuidC);
const WS_SLUG = WorkspaceSlug("default");

let repo: InMemoryInvitationRepository;
let workspaces: FakeWorkspaceReader;
let grantor: InMemoryMembershipGrantor;
let tokens: SeqTokenGenerator;
let clock: FixedClock;

beforeEach(() => {
  repo = new InMemoryInvitationRepository();
  workspaces = new FakeWorkspaceReader(
    [{ id: WS_ID, slug: WS_SLUG, name: "Default" }],
    new Map(),
    [],
  );
  grantor = new InMemoryMembershipGrantor();
  tokens = new SeqTokenGenerator();
  clock = new FixedClock(new Date("2026-04-18T00:00:00Z"));
});

function send(overrides: Partial<Parameters<typeof sendInvitation>[1]> = {}) {
  return sendInvitation(
    {
      invitations: repo,
      workspaces,
      adminGuard: new AllowAllAdmin(),
      tokens,
      clock,
    },
    {
      actor: ACTOR,
      workspaceId: WS_ID,
      email: Email("bob@example.com"),
      role: Role("member"),
      ...overrides,
    },
  );
}

describe("sendInvitation", () => {
  it("creates an invitation with token and TTL-based expiry", async () => {
    const inv = await send();
    expect(inv.email).toBe(Email("bob@example.com"));
    expect(inv.role).toBe("member");
    expect(inv.token).toBe(InvitationToken("tok-1"));
    // default TTL = 14 days
    expect(inv.expiresAt.getTime() - clock.now().getTime()).toBe(
      14 * 24 * 60 * 60 * 1000,
    );
  });

  it("rejects when the actor is not an admin", async () => {
    await expect(
      sendInvitation(
        {
          invitations: repo,
          workspaces,
          adminGuard: new DenyAdmin(),
          tokens,
          clock,
        },
        {
          actor: ACTOR,
          workspaceId: WS_ID,
          email: Email("bob@example.com"),
          role: Role("member"),
        },
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects when invitee is already a member", async () => {
    workspaces = new FakeWorkspaceReader(
      [{ id: WS_ID, slug: WS_SLUG, name: "Default" }],
      new Map([["bob@example.com", BOB]]),
      [{ userId: BOB, workspaceId: WS_ID }],
    );
    await expect(
      sendInvitation(
        {
          invitations: repo,
          workspaces,
          adminGuard: new AllowAllAdmin(),
          tokens,
          clock,
        },
        {
          actor: ACTOR,
          workspaceId: WS_ID,
          email: Email("bob@example.com"),
          role: Role("member"),
        },
      ),
    ).rejects.toBeInstanceOf(AlreadyMemberError);
  });

  it("rejects when a pending invitation already exists for that email", async () => {
    await send();
    await expect(send()).rejects.toBeInstanceOf(
      InvitationAlreadyPendingError,
    );
  });
});

describe("acceptInvitation", () => {
  it("grants membership and marks the invitation accepted", async () => {
    const inv = await send();
    const deps = {
      invitations: repo,
      workspaces,
      memberships: grantor,
      clock,
    };
    const result = await acceptInvitation(deps, {
      acceptor: BOB,
      acceptorEmail: Email("bob@example.com"),
      token: inv.token,
    });
    expect(result.workspaceSlug).toBe("default");
    expect(grantor.grants).toHaveLength(1);
    expect(grantor.grants[0]!.role).toBe("member");
    const reloaded = await repo.findByToken(inv.token);
    expect(reloaded!.acceptedAt).not.toBeNull();
  });

  it("rejects a token that doesn't exist", async () => {
    await expect(
      acceptInvitation(
        { invitations: repo, workspaces, memberships: grantor, clock },
        {
          acceptor: BOB,
          acceptorEmail: Email("bob@example.com"),
          token: InvitationToken("ghost"),
        },
      ),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);
  });

  it("rejects email mismatch", async () => {
    const inv = await send();
    await expect(
      acceptInvitation(
        { invitations: repo, workspaces, memberships: grantor, clock },
        {
          acceptor: BOB,
          acceptorEmail: Email("mallory@example.com"),
          token: inv.token,
        },
      ),
    ).rejects.toBeInstanceOf(InvitationEmailMismatchError);
  });

  it("rejects once accepted", async () => {
    const inv = await send();
    await acceptInvitation(
      { invitations: repo, workspaces, memberships: grantor, clock },
      {
        acceptor: BOB,
        acceptorEmail: Email("bob@example.com"),
        token: inv.token,
      },
    );
    await expect(
      acceptInvitation(
        { invitations: repo, workspaces, memberships: grantor, clock },
        {
          acceptor: BOB,
          acceptorEmail: Email("bob@example.com"),
          token: inv.token,
        },
      ),
    ).rejects.toBeInstanceOf(InvitationAlreadyAcceptedError);
  });

  it("rejects after expiry", async () => {
    const inv = await send();
    clock.advance(30 * 24 * 60 * 60 * 1000); // 30 days
    await expect(
      acceptInvitation(
        { invitations: repo, workspaces, memberships: grantor, clock },
        {
          acceptor: BOB,
          acceptorEmail: Email("bob@example.com"),
          token: inv.token,
        },
      ),
    ).rejects.toBeInstanceOf(InvitationExpiredError);
  });
});

describe("revokeInvitation", () => {
  it("marks the invitation revoked when actor is admin", async () => {
    const inv = await send();
    await revokeInvitation(
      { invitations: repo, adminGuard: new AllowAllAdmin(), clock },
      ACTOR,
      inv.id,
    );
    const reloaded = await repo.findById(inv.id);
    expect(reloaded!.revokedAt).not.toBeNull();
  });

  it("rejects a non-admin actor", async () => {
    const inv = await send();
    await expect(
      revokeInvitation(
        { invitations: repo, adminGuard: new DenyAdmin(), clock },
        ACTOR,
        inv.id,
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects once revoked", async () => {
    const inv = await send();
    await revokeInvitation(
      { invitations: repo, adminGuard: new AllowAllAdmin(), clock },
      ACTOR,
      inv.id,
    );
    await expect(
      revokeInvitation(
        { invitations: repo, adminGuard: new AllowAllAdmin(), clock },
        ACTOR,
        inv.id,
      ),
    ).rejects.toBeInstanceOf(InvitationRevokedError);
  });
});

describe("listInvitations", () => {
  it("returns all invitations for the workspace", async () => {
    await send({ email: Email("bob@example.com") });
    await send({ email: Email("carol@example.com") });
    const rows = await listInvitations(
      { invitations: repo, adminGuard: new AllowAllAdmin() },
      ACTOR,
      WS_ID,
    );
    expect(rows).toHaveLength(2);
  });

  it("requires admin", async () => {
    await expect(
      listInvitations(
        { invitations: repo, adminGuard: new DenyAdmin() },
        ACTOR,
        WS_ID,
      ),
    ).rejects.toBeTruthy();
  });
});
