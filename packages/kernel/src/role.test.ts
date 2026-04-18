import { describe, it, expect } from "bun:test";
import { Role, satisfies } from "./role.js";
import { ValidationError } from "./errors.js";

describe("Role", () => {
  it.each(["member", "admin", "owner"])("accepts %p", (r) => {
    expect(Role(r)).toBe(r as "member" | "admin" | "owner");
  });

  it("rejects unknown role strings", () => {
    expect(() => Role("superuser")).toThrow(ValidationError);
  });
});

describe("satisfies", () => {
  it("lets a higher role satisfy a lower requirement", () => {
    expect(satisfies("owner", "member")).toBe(true);
    expect(satisfies("owner", "admin")).toBe(true);
    expect(satisfies("admin", "member")).toBe(true);
  });

  it("is reflexive", () => {
    expect(satisfies("member", "member")).toBe(true);
    expect(satisfies("admin", "admin")).toBe(true);
    expect(satisfies("owner", "owner")).toBe(true);
  });

  it("rejects lower role against higher requirement", () => {
    expect(satisfies("member", "admin")).toBe(false);
    expect(satisfies("member", "owner")).toBe(false);
    expect(satisfies("admin", "owner")).toBe(false);
  });
});
