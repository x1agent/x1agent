import { describe, it, expect, beforeEach } from "bun:test";
import { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import {
  InMemoryInvitationRepository,
  AllowAllAdmin,
  DenyAdmin,
} from "./fakes.js";
import { changeInvitationRole } from "./change-invitation-role.js";
import {
  InvitationNotFoundError,
  InvitationAlreadyAcceptedError,
  InvitationRevokedError,
} from "../domain/errors.js";
import { InvitationId } from "@x1agent/kernel";
import { InvitationToken } from "../domain/invitation.js";

const WS = WorkspaceId("00000000-0000-7000-8000-000000000001");
const ACTOR = UserId("00000000-0000-7000-8000-000000000aaa");

let repo: InMemoryInvitationRepository;

beforeEach(() => {
  repo = new InMemoryInvitationRepository();
});

async function seedPending(role: Role = Role("member")) {
  return repo.create({
    workspaceId: WS,
    email: Email("invitee@example.com"),
    role,
    token: InvitationToken("tok"),
    invitedBy: ACTOR,
    expiresAt: new Date(Date.now() + 86400_000),
  });
}

describe("changeInvitationRole", () => {
  it("changes the role on a pending invitation", async () => {
    const inv = await seedPending(Role("member"));
    const updated = await changeInvitationRole(
      { invitations: repo, adminGuard: new AllowAllAdmin() },
      ACTOR,
      inv.id,
      Role("admin"),
    );
    expect(updated.role).toBe(Role("admin"));
    expect(updated.id).toBe(inv.id);
  });

  it("is idempotent when the role already matches", async () => {
    const inv = await seedPending(Role("admin"));
    const updated = await changeInvitationRole(
      { invitations: repo, adminGuard: new AllowAllAdmin() },
      ACTOR,
      inv.id,
      Role("admin"),
    );
    expect(updated.role).toBe(Role("admin"));
  });

  it("rejects when the caller isn't admin (admin gate first, before any state checks)", async () => {
    const inv = await seedPending();
    await expect(
      changeInvitationRole(
        { invitations: repo, adminGuard: new DenyAdmin() },
        ACTOR,
        inv.id,
        Role("admin"),
      ),
    ).rejects.toBeTruthy();
  });

  it("404s for an unknown invitation", async () => {
    await expect(
      changeInvitationRole(
        { invitations: repo, adminGuard: new AllowAllAdmin() },
        ACTOR,
        InvitationId("00000000-0000-7000-8000-deadbeefdead"),
        Role("admin"),
      ),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);
  });

  it("refuses to edit an accepted invitation", async () => {
    const inv = await seedPending();
    await repo.markAccepted(inv.id, ACTOR, new Date());
    await expect(
      changeInvitationRole(
        { invitations: repo, adminGuard: new AllowAllAdmin() },
        ACTOR,
        inv.id,
        Role("admin"),
      ),
    ).rejects.toBeInstanceOf(InvitationAlreadyAcceptedError);
  });

  it("refuses to edit a revoked invitation", async () => {
    const inv = await seedPending();
    await repo.markRevoked(inv.id, new Date());
    await expect(
      changeInvitationRole(
        { invitations: repo, adminGuard: new AllowAllAdmin() },
        ACTOR,
        inv.id,
        Role("admin"),
      ),
    ).rejects.toBeInstanceOf(InvitationRevokedError);
  });

  it("tenant isolation: assertAdmin is called against the invitation's own workspace (not the actor's home)", async () => {
    // Workspace A holds the invitation; workspace B is unrelated. The
    // admin guard records what workspace it was called against — we
    // must see WS (the invitation's row), proving the use case is
    // deriving the workspace from the invitation, not from the actor
    // or the request body.
    const inv = await seedPending(Role("member"));
    let seenWorkspaceId: string | null = null;
    const guard = {
      async assertAdmin(_u: string, w: string) {
        seenWorkspaceId = w;
      },
    } as unknown as import("../ports/admin-guard.js").AdminGuard;
    await changeInvitationRole(
      { invitations: repo, adminGuard: guard },
      ACTOR,
      inv.id,
      Role("admin"),
    );
    expect(seenWorkspaceId).toBe(WS as unknown as string);
  });
});
