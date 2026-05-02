import { describe, it, expect } from "bun:test";
import { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import {
  assertHasMembership,
  type AuthSession,
  type WorkspaceMembership,
} from "./auth-session.js";
import { NoWorkspaceMembershipError } from "./errors.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

function membership(): WorkspaceMembership {
  return {
    workspaceId: WorkspaceId(uuid),
    slug: "default",
    name: "Default",
    role: Role("owner"),
  };
}

function session(memberships: WorkspaceMembership[]): AuthSession {
  return {
    userId: UserId(uuid),
    email: Email("alice@example.com"),
    name: "Alice",
    memberships,
    isPlatformAdmin: false,
  };
}

describe("assertHasMembership", () => {
  it("passes through sessions with at least one membership", () => {
    const s = session([membership()]);
    expect(assertHasMembership(s)).toBe(s);
  });

  it("throws NoWorkspaceMembershipError for non-admin with zero memberships", () => {
    const s = session([]);
    expect(() => assertHasMembership(s)).toThrow(NoWorkspaceMembershipError);
  });

  it("lets a platform admin through with zero memberships (bootstrap path)", () => {
    const s: AuthSession = { ...session([]), isPlatformAdmin: true };
    expect(assertHasMembership(s)).toBe(s);
  });

  it("error carries the offending email", () => {
    try {
      assertHasMembership(session([]));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoWorkspaceMembershipError);
      expect((err as NoWorkspaceMembershipError).email).toBe(
        "alice@example.com",
      );
    }
  });
});
