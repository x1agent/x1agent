import { describe, it, expect } from "bun:test";
import type { AuthProvider } from "../ports/auth-provider.js";
import type { AuthProfile } from "../domain/auth-profile.js";

export interface AuthProviderFixture {
  /** Human-readable name of the adapter, used in the describe block. */
  name: string;

  /** Construct a fresh adapter per test. Must be side-effect free. */
  factory: () => AuthProvider;

  /**
   * A (code, expected profile) pair the adapter can resolve. Adapters that
   * wrap a remote service must stub the remote at this level — the
   * contract test is offline.
   */
  validExchange: { code: string; expected: AuthProfile };

  /** A code the adapter should reject. */
  invalidCode: string;
}

/**
 * Run the AuthProvider contract against any adapter. Adapters call this
 * from their own package's test file.
 */
export function runAuthProviderContract(fx: AuthProviderFixture) {
  describe(`AuthProvider contract — ${fx.name}`, () => {
    it("has a non-empty id", () => {
      expect(fx.factory().id.length).toBeGreaterThan(0);
    });

    it("builds an authorize URL that contains the redirect_uri", () => {
      const p = fx.factory();
      const url = p.getAuthorizeUrl("https://x1agent.test/cb");
      expect(url).toContain("x1agent.test");
    });

    it("preserves the `state` parameter when provided", () => {
      const p = fx.factory();
      const url = new URL(p.getAuthorizeUrl("https://x1agent.test/cb", "xyz"));
      expect(url.searchParams.get("state")).toBe("xyz");
    });

    it("omits state when not provided", () => {
      const p = fx.factory();
      const url = new URL(p.getAuthorizeUrl("https://x1agent.test/cb"));
      expect(url.searchParams.has("state")).toBe(false);
    });

    it("exchanges a valid code into a normalized profile", async () => {
      const p = fx.factory();
      const profile = await p.exchangeCode(
        fx.validExchange.code,
        "https://x1agent.test/cb",
      );
      expect(profile.email).toBe(fx.validExchange.expected.email);
      expect(profile.providerId).toBe(p.id);
      expect(profile.providerUserId).toBe(
        fx.validExchange.expected.providerUserId,
      );
    });

    it("rejects an invalid code", async () => {
      const p = fx.factory();
      await expect(
        p.exchangeCode(fx.invalidCode, "https://x1agent.test/cb"),
      ).rejects.toBeTruthy();
    });
  });
}
