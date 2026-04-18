import { describe, it, expect } from "bun:test";
import { Email } from "@x1agent/kernel";
import { isPlatformAdmin } from "./platform-admin.js";

describe("isPlatformAdmin", () => {
  it("matches case-insensitively", () => {
    expect(
      isPlatformAdmin(Email("admin@example.com"), ["ADMIN@example.com"]),
    ).toBe(true);
  });

  it("returns false when the email is not in the list", () => {
    expect(
      isPlatformAdmin(Email("stranger@example.com"), ["admin@example.com"]),
    ).toBe(false);
  });

  it("returns false for an empty allowlist", () => {
    expect(isPlatformAdmin(Email("admin@example.com"), [])).toBe(false);
  });

  it("trims whitespace in the allowlist", () => {
    expect(
      isPlatformAdmin(Email("admin@example.com"), ["  admin@example.com  "]),
    ).toBe(true);
  });
});
