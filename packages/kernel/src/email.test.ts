import { describe, it, expect } from "bun:test";
import { Email, domainOf } from "./email.js";
import { ValidationError } from "./errors.js";

describe("Email", () => {
  it("normalizes to lowercase and trims whitespace", () => {
    expect(Email("  Alice@Example.com  ")).toBe("alice@example.com");
  });

  it("rejects values without an @", () => {
    expect(() => Email("notanemail")).toThrow(ValidationError);
  });

  it("rejects empty string", () => {
    expect(() => Email("")).toThrow(ValidationError);
  });

  it("rejects values without a domain dot", () => {
    expect(() => Email("user@example")).toThrow(ValidationError);
  });

  it("accepts emails with plus-addressing", () => {
    expect(Email("user+tag@example.com")).toBe("user+tag@example.com");
  });

  describe("domainOf", () => {
    it("returns the host portion", () => {
      expect(domainOf(Email("user@example.com"))).toBe("example.com");
    });
  });
});
