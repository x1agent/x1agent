import { describe, it, expect } from "bun:test";
import { UserId, WorkspaceId, InvitationId } from "./ids.js";
import { ValidationError } from "./errors.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

describe("id constructors", () => {
  it("accepts valid UUIDs and lowercases them", () => {
    expect(UserId(uuid)).toBe(uuid);
    expect(UserId(uuid.toUpperCase())).toBe(uuid);
    expect(WorkspaceId(uuid)).toBe(uuid);
    expect(InvitationId(uuid)).toBe(uuid);
  });

  it("rejects non-UUID strings", () => {
    expect(() => UserId("not-a-uuid")).toThrow(ValidationError);
    expect(() => WorkspaceId("12345")).toThrow(ValidationError);
    expect(() => InvitationId("")).toThrow(ValidationError);
  });
});
