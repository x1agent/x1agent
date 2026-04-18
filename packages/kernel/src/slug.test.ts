import { describe, it, expect } from "bun:test";
import { WorkspaceSlug } from "./slug.js";
import { ValidationError } from "./errors.js";

describe("WorkspaceSlug", () => {
  it.each([
    ["default", "default"],
    ["my-team", "my-team"],
    ["  TeamX  ", "teamx"],
    ["a1-b2-c3", "a1-b2-c3"],
  ])("accepts %p and normalizes to %p", (input, expected) => {
    expect(WorkspaceSlug(input)).toBe(expected);
  });

  it.each([
    "",
    "a",
    "1abc",
    "-abc",
    "abc_def",
    "ABC def",
    "a".repeat(33),
  ])("rejects %p", (input) => {
    expect(() => WorkspaceSlug(input)).toThrow(ValidationError);
  });
});
