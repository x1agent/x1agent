import { describe, it, expect } from "bun:test";
import { SecretName } from "./secret-name.js";
import { ValidationError } from "@x1agent/kernel";

describe("SecretName", () => {
  it.each([
    "MY_API_KEY",
    "X",
    "_PRIVATE",
    "API_KEY_2",
    "A".repeat(64),
  ])("accepts %p", (input) => {
    expect(() => SecretName(input)).not.toThrow();
  });

  it.each([
    "",
    "lowercase",
    "Mixed_Case",
    "1STARTS_WITH_DIGIT",
    "WITH-HYPHEN",
    "WITH SPACE",
    "WITH.DOT",
    "${TEMPLATE}",
    "A".repeat(65),
  ])("rejects %p", (input) => {
    expect(() => SecretName(input)).toThrow(ValidationError);
  });

  it("trims whitespace before validating", () => {
    expect(SecretName("  MY_VAR  ") as unknown as string).toBe("MY_VAR");
  });
});
