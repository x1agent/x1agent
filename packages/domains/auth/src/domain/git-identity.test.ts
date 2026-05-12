import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import { parseGitIdentity } from "./git-identity.js";

describe("parseGitIdentity", () => {
  it("trims surrounding whitespace on both fields", () => {
    const id = parseGitIdentity({
      name: "  Jane Doe  ",
      email: "  jane@example.com  ",
    });
    expect(id.name).toBe("Jane Doe");
    expect(id.email).toBe("jane@example.com");
  });

  it("preserves case in email — git's commit trailer is case-sensitive", () => {
    // Unlike the kernel Email value-object (which lowercases for unique
    // constraint hygiene), git_email is a free-form attribution string
    // forwarded to GitHub's commit author; the user types it the way
    // GitHub stores it.
    const id = parseGitIdentity({ name: "x", email: "Jane@Example.COM" });
    expect(id.email).toBe("Jane@Example.COM");
  });

  it("accepts GitHub noreply emails (the recommended privacy default)", () => {
    const id = parseGitIdentity({
      name: "dev360",
      email: "12345+dev360@users.noreply.github.com",
    });
    expect(id.email).toBe("12345+dev360@users.noreply.github.com");
  });

  it("rejects empty name with field=git_name", () => {
    expect(() => parseGitIdentity({ name: "", email: "j@e.com" })).toThrow(
      ValidationError,
    );
    try {
      parseGitIdentity({ name: "  ", email: "j@e.com" });
    } catch (e) {
      expect((e as ValidationError).field).toBe("git_name");
    }
  });

  it("rejects empty email with field=git_email", () => {
    try {
      parseGitIdentity({ name: "Jane", email: "" });
    } catch (e) {
      expect((e as ValidationError).field).toBe("git_email");
    }
  });

  it("rejects garbage email with field=git_email", () => {
    try {
      parseGitIdentity({ name: "Jane", email: "not-an-email" });
    } catch (e) {
      expect((e as ValidationError).field).toBe("git_email");
    }
  });

  it("rejects control characters in name (CRLF / null injection)", () => {
    try {
      parseGitIdentity({
        name: "Jane\nEvil <evil@e.com>",
        email: "j@e.com",
      });
    } catch (e) {
      expect((e as ValidationError).field).toBe("git_name");
    }
  });

  it("rejects control characters in email", () => {
    try {
      parseGitIdentity({ name: "Jane", email: "j@e.com\nEvil" });
    } catch (e) {
      expect((e as ValidationError).field).toBe("git_email");
    }
  });

  it("rejects names over 200 characters", () => {
    const long = "a".repeat(201);
    try {
      parseGitIdentity({ name: long, email: "j@e.com" });
    } catch (e) {
      expect((e as ValidationError).field).toBe("git_name");
    }
  });

  it("rejects emails over 200 characters", () => {
    const long = "a".repeat(190) + "@e.com";
    try {
      parseGitIdentity({ name: "Jane", email: long });
    } catch (e) {
      expect((e as ValidationError).field).toBe("git_email");
    }
  });
});
