import { describe, it, expect } from "bun:test";
import { Email } from "@x1agent/kernel";
import { assertAllowedDomain, type AuthProfile } from "./auth-profile.js";
import { DomainNotAllowedError } from "./errors.js";

function profile(email: string): AuthProfile {
  return {
    email: Email(email),
    name: "User",
    avatarUrl: null,
    providerUserId: "sub-1",
    providerId: "google",
  };
}

describe("assertAllowedDomain", () => {
  it("passes through when allowlist is empty", () => {
    const p = profile("anyone@anywhere.com");
    expect(assertAllowedDomain(p, [])).toBe(p);
  });

  it("passes through when domain is in the allowlist", () => {
    const p = profile("user@example.com");
    expect(assertAllowedDomain(p, ["example.com"]).email).toBe(p.email);
  });

  it("throws DomainNotAllowedError when domain is not allowlisted", () => {
    const p = profile("user@stranger.com");
    expect(() => assertAllowedDomain(p, ["example.com"])).toThrow(
      DomainNotAllowedError,
    );
  });

  it("carries the attempted domain and the allowlist on the error", () => {
    const p = profile("user@stranger.com");
    try {
      assertAllowedDomain(p, ["a.com", "b.com"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainNotAllowedError);
      const e = err as DomainNotAllowedError;
      expect(e.domain).toBe("stranger.com");
      expect(e.allowed).toEqual(["a.com", "b.com"]);
      expect(e.code).toBe("domain_not_allowed");
    }
  });
});
