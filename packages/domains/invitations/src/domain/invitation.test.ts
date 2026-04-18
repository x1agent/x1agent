import { describe, it, expect } from "bun:test";
import {
  Email,
  InvitationId,
  Role,
  UserId,
  WorkspaceId,
} from "@x1agent/kernel";
import {
  canAccept,
  InvitationToken,
  isActive,
  type Invitation,
} from "./invitation.js";
import {
  InvitationAlreadyAcceptedError,
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationRevokedError,
} from "./errors.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

function inv(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: InvitationId(uuid),
    workspaceId: WorkspaceId(uuid),
    email: Email("alice@example.com"),
    role: Role("member"),
    token: InvitationToken("tok"),
    invitedBy: UserId(uuid),
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    acceptedAt: null,
    acceptedBy: null,
    revokedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const NOW = new Date("2026-04-18T00:00:00Z");

describe("canAccept", () => {
  it("accepts a pending, matching, unexpired invitation", () => {
    expect(() => canAccept(inv(), Email("alice@example.com"), NOW)).not.toThrow();
  });

  it("is case-insensitive on email (Email normalizes)", () => {
    expect(() => canAccept(inv(), Email("ALICE@example.com"), NOW)).not.toThrow();
  });

  it("rejects after acceptance", () => {
    expect(() =>
      canAccept(inv({ acceptedAt: NOW }), Email("alice@example.com"), NOW),
    ).toThrow(InvitationAlreadyAcceptedError);
  });

  it("rejects when revoked", () => {
    expect(() =>
      canAccept(inv({ revokedAt: NOW }), Email("alice@example.com"), NOW),
    ).toThrow(InvitationRevokedError);
  });

  it("rejects when expired", () => {
    expect(() =>
      canAccept(
        inv({ expiresAt: new Date("2024-01-01T00:00:00Z") }),
        Email("alice@example.com"),
        NOW,
      ),
    ).toThrow(InvitationExpiredError);
  });

  it("rejects when email mismatches", () => {
    expect(() => canAccept(inv(), Email("bob@example.com"), NOW)).toThrow(
      InvitationEmailMismatchError,
    );
  });
});

describe("isActive", () => {
  it("is true for a pending, unexpired invitation", () => {
    expect(isActive(inv(), NOW)).toBe(true);
  });

  it("is false once accepted", () => {
    expect(isActive(inv({ acceptedAt: NOW }), NOW)).toBe(false);
  });

  it("is false once revoked", () => {
    expect(isActive(inv({ revokedAt: NOW }), NOW)).toBe(false);
  });

  it("is false past expiry", () => {
    expect(
      isActive(inv({ expiresAt: new Date("2024-01-01T00:00:00Z") }), NOW),
    ).toBe(false);
  });
});
