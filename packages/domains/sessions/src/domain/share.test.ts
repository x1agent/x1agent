import { describe, it, expect } from "bun:test";
import { isShareRole, InvalidShareRoleError, CannotShareWithSelfError } from "./share.js";

describe("isShareRole", () => {
  it("accepts viewer + collaborator", () => {
    expect(isShareRole("viewer")).toBe(true);
    expect(isShareRole("collaborator")).toBe(true);
  });
  it("rejects everything else (case-sensitive)", () => {
    expect(isShareRole("Viewer")).toBe(false);
    expect(isShareRole("admin")).toBe(false);
    expect(isShareRole("")).toBe(false);
    expect(isShareRole("owner")).toBe(false);
  });
});

describe("share-domain errors", () => {
  it("InvalidShareRoleError carries the offending raw value + a stable code", () => {
    const e = new InvalidShareRoleError("oops");
    expect(e.code).toBe("invalid_share_role");
    expect(e.raw).toBe("oops");
    expect(e.message).toContain("oops");
  });
  it("CannotShareWithSelfError code", () => {
    expect(new CannotShareWithSelfError().code).toBe("cannot_share_with_self");
  });
});
