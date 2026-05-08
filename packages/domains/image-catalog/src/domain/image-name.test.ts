import { describe, it, expect } from "bun:test";
import { ImageName } from "./image-name.js";
import { ValidationError } from "@x1agent/kernel";

describe("ImageName", () => {
  it.each([
    "x",
    "django",
    "python-django",
    "node-22",
    "a".repeat(63),
  ])("accepts %p", (input) => {
    expect(() => ImageName(input)).not.toThrow();
  });

  it.each([
    "",
    "Django",
    "1starts-with-digit",
    "-starts-with-hyphen",
    "ends-with-hyphen-",
    "double--hyphen",
    "with_underscore",
    "with space",
    "with.dot",
    "a".repeat(64),
  ])("rejects %p", (input) => {
    expect(() => ImageName(input)).toThrow(ValidationError);
  });

  it("trims whitespace before validating", () => {
    expect(ImageName("  django  ") as unknown as string).toBe("django");
  });
});
