import { describe, it, expect, beforeEach } from "bun:test";
import { Email, Role } from "@x1agent/kernel";
import { signInWithCode, type SignInDeps } from "./sign-in.js";
import {
  InMemoryAuthProvider,
  InMemoryUserRepository,
  InMemorySessionTokenizer,
} from "./fakes.js";
import {
  DomainNotAllowedError,
  InvalidAuthCodeError,
  NoWorkspaceMembershipError,
} from "../domain/errors.js";
import type { AuthProfile } from "../domain/auth-profile.js";

const aliceProfile: AuthProfile = {
  email: Email("alice@example.com"),
  name: "Alice",
  avatarUrl: null,
  providerUserId: "google-sub-alice",
  providerId: "fake",
};

const strangerProfile: AuthProfile = {
  email: Email("stranger@stranger.com"),
  name: "Stranger",
  avatarUrl: null,
  providerUserId: "google-sub-stranger",
  providerId: "fake",
};

function makeDeps(overrides: Partial<SignInDeps> = {}): SignInDeps {
  const provider = new InMemoryAuthProvider(
    new Map([
      ["alice-code", aliceProfile],
      ["stranger-code", strangerProfile],
    ]),
  );
  const users = new InMemoryUserRepository();
  const tokenizer = new InMemorySessionTokenizer();
  return {
    authProvider: provider,
    users,
    tokenizer,
    allowedDomains: [],
    platformAdmins: [],
    ...overrides,
  };
}

describe("signInWithCode", () => {
  it("creates a user, attaches memberships, and returns a token", async () => {
    const deps = makeDeps();
    const users = deps.users as InMemoryUserRepository;

    // Seed a workspace membership that will be applied after the user is upserted.
    // We hook the upsertFromProfile to seed once the user exists.
    const origUpsert = users.upsertFromProfile.bind(users);
    users.upsertFromProfile = async (p) => {
      const u = await origUpsert(p);
      users.seedMembership(u.id, "default", "Default", Role("owner"));
      return u;
    };

    const result = await signInWithCode(
      deps,
      "alice-code",
      "http://localhost/cb",
    );
    expect(result.session.email).toBe(Email("alice@example.com"));
    expect(result.session.memberships).toHaveLength(1);
    expect(result.session.memberships[0]!.slug).toBe("default");
    expect(result.token).toContain("fake-token::");
  });

  it("rejects users outside the allowed domains", async () => {
    const deps = makeDeps({ allowedDomains: ["example.com"] });
    await expect(
      signInWithCode(deps, "stranger-code", "http://localhost/cb"),
    ).rejects.toBeInstanceOf(DomainNotAllowedError);
  });

  it("rejects users with no workspace memberships", async () => {
    const deps = makeDeps();
    // No memberships seeded — upsert creates the user but listMemberships is empty.
    await expect(
      signInWithCode(deps, "alice-code", "http://localhost/cb"),
    ).rejects.toBeInstanceOf(NoWorkspaceMembershipError);
  });

  it("rejects an unknown authorization code", async () => {
    const deps = makeDeps();
    await expect(
      signInWithCode(deps, "made-up", "http://localhost/cb"),
    ).rejects.toBeInstanceOf(InvalidAuthCodeError);
  });

  it("bypasses the domain allowlist when accessGate.isPreAuthorized is true", async () => {
    const deps = makeDeps({
      allowedDomains: ["example.com"],
      // Stranger isn't on example.com but the access gate says yes
      // (e.g. they have a pending invitation).
      accessGate: { async isPreAuthorized(e) {
        return e === Email("stranger@stranger.com");
      } },
    });
    const users = deps.users as InMemoryUserRepository;
    const orig = users.upsertFromProfile.bind(users);
    users.upsertFromProfile = async (p) => {
      const u = await orig(p);
      users.seedMembership(u.id, "default", "Default", Role("owner"));
      return u;
    };
    const { session } = await signInWithCode(
      deps,
      "stranger-code",
      "http://localhost/cb",
    );
    expect(session.email).toBe(Email("stranger@stranger.com"));
  });

  it("still rejects domain-blocked users when accessGate.isPreAuthorized is false", async () => {
    const deps = makeDeps({
      allowedDomains: ["example.com"],
      accessGate: { async isPreAuthorized() { return false; } },
    });
    await expect(
      signInWithCode(deps, "stranger-code", "http://localhost/cb"),
    ).rejects.toBeInstanceOf(DomainNotAllowedError);
  });

  it("marks platform admins in the session", async () => {
    const deps = makeDeps({ platformAdmins: ["alice@example.com"] });
    const users = deps.users as InMemoryUserRepository;
    const orig = users.upsertFromProfile.bind(users);
    users.upsertFromProfile = async (p) => {
      const u = await orig(p);
      users.seedMembership(u.id, "default", "Default", Role("owner"));
      return u;
    };
    const { session } = await signInWithCode(
      deps,
      "alice-code",
      "http://localhost/cb",
    );
    expect(session.isPlatformAdmin).toBe(true);
  });
});
