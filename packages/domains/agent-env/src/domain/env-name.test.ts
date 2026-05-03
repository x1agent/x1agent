import { describe, it, expect } from "bun:test";
import { EnvName } from "./env-name.js";
import { ValidationError } from "@x1agent/kernel";

describe("EnvName", () => {
  it.each([
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "_PRIVATE",
    "DEPLOY_TOKEN_2",
    "A".repeat(64),
  ])("accepts %p", (input) => {
    expect(() => EnvName(input)).not.toThrow();
  });

  it.each([
    "",
    "lowercase",
    "Mixed_Case",
    "1STARTS_WITH_DIGIT",
    "WITH-HYPHEN",
    "WITH SPACE",
    "${TEMPLATE}",
    "A".repeat(65),
  ])("rejects %p", (input) => {
    expect(() => EnvName(input)).toThrow(ValidationError);
  });
});
