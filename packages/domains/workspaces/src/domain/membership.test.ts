import { describe, it, expect } from "bun:test";
import { Role, UserId, WorkspaceId } from "@x1agent/kernel";
import {
  assertRoleAtLeast,
  InsufficientRoleError,
  NotAMemberError,
  type Membership,
} from "./membership.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

function membership(role: Role): Membership {
  return {
    workspaceId: WorkspaceId(uuid),
    userId: UserId(uuid),
    role,
    addedAt: new Date(),
  };
}

describe("assertRoleAtLeast", () => {
  it("passes through when role meets requirement", () => {
    const m = membership(Role("admin"));
    expect(assertRoleAtLeast(m, Role("admin"))).toBe(m);
    expect(assertRoleAtLeast(m, Role("member"))).toBe(m);
  });

  it("throws InsufficientRoleError when role is lower", () => {
    const m = membership(Role("member"));
    expect(() => assertRoleAtLeast(m, Role("admin"))).toThrow(
      InsufficientRoleError,
    );
  });

  it("throws NotAMemberError when membership is null", () => {
    expect(() => assertRoleAtLeast(null, Role("member"))).toThrow(
      NotAMemberError,
    );
  });

  it("carries the offending role on InsufficientRoleError", () => {
    try {
      assertRoleAtLeast(membership(Role("member")), Role("owner"));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientRoleError);
      const e = err as InsufficientRoleError;
      expect(e.actual).toBe("member");
      expect(e.required).toBe("owner");
      expect(e.code).toBe("insufficient_role");
    }
  });
});
