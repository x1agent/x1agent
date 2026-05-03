import { describe, it, expect } from "bun:test";
import { CatalogName } from "./catalog-name.js";
import { ValidationError } from "@x1agent/kernel";

describe("CatalogName", () => {
  it.each([
    "linear",
    "drive-mcp",
    "linear_v2",
    "x",
    "a".repeat(64),
  ])("accepts %p", (input) => {
    expect(() => CatalogName(input)).not.toThrow();
  });

  it.each([
    "",
    "Linear",
    "1starts_with_digit",
    "_starts_with_underscore",
    "with space",
    "with.dot",
    "${TEMPLATE}",
    "a".repeat(65),
  ])("rejects %p", (input) => {
    expect(() => CatalogName(input)).toThrow(ValidationError);
  });

  it("trims whitespace before validating", () => {
    expect(CatalogName("  linear  ") as unknown as string).toBe("linear");
  });
});
