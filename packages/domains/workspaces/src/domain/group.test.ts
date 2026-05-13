import { describe, it, expect } from "bun:test";
import {
  GroupNameInvalidError,
  validateGroupDescription,
  validateGroupName,
} from "./group.js";

describe("validateGroupName", () => {
  it("accepts a normal name and returns it trimmed", () => {
    expect(validateGroupName("  Design  ")).toBe("Design");
  });

  it("accepts a single-character name", () => {
    expect(validateGroupName("X")).toBe("X");
  });

  it("accepts an 80-character name (boundary)", () => {
    const eighty = "x".repeat(80);
    expect(validateGroupName(eighty)).toBe(eighty);
  });

  it("rejects empty after trim", () => {
    expect(() => validateGroupName("")).toThrow(GroupNameInvalidError);
    expect(() => validateGroupName("   ")).toThrow(GroupNameInvalidError);
  });

  it("rejects 81+ characters after trim", () => {
    expect(() => validateGroupName("x".repeat(81))).toThrow(
      GroupNameInvalidError,
    );
  });

  it("rejects names starting with @ (reserved for future @mention)", () => {
    expect(() => validateGroupName("@design")).toThrow(GroupNameInvalidError);
    // The @-prefix check runs after trim, so leading whitespace + @ still trips.
    expect(() => validateGroupName("   @design")).toThrow(
      GroupNameInvalidError,
    );
  });
});

describe("validateGroupDescription", () => {
  it("returns null for null / undefined / empty", () => {
    expect(validateGroupDescription(null)).toBeNull();
    expect(validateGroupDescription(undefined)).toBeNull();
    expect(validateGroupDescription("")).toBeNull();
    expect(validateGroupDescription("   ")).toBeNull();
  });

  it("returns trimmed content", () => {
    expect(validateGroupDescription("  hello world  ")).toBe("hello world");
  });

  it("accepts 500 chars (boundary)", () => {
    const five = "x".repeat(500);
    expect(validateGroupDescription(five)).toBe(five);
  });

  it("rejects 501+ chars", () => {
    expect(() => validateGroupDescription("x".repeat(501))).toThrow(
      GroupNameInvalidError,
    );
  });
});
