import { describe, it, expect, beforeEach } from "bun:test";
import { Email, FixedClock, UserId } from "@x1agent/kernel";
import { InMemoryAuthProvider, InMemoryUserRepository } from "./fakes.js";
import {
  InMemoryLinkAttemptStore,
  InMemoryPersonRepository,
} from "./linking-fakes.js";
import { beginLink } from "./begin-link.js";
import { completeLink } from "./complete-link.js";
import {
  CrossPersonLinkError,
  LinkAttemptExpiredError,
  LinkAttemptNotFoundError,
} from "../domain/errors.js";
import { PersonId } from "../domain/person.js";
import type { AuthProfile } from "../domain/auth-profile.js";
import { LinkState } from "../domain/link-attempt.js";

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const ALICE_HOME: AuthProfile = {
  email: Email("alice@example.com"),
  name: "Alice",
  avatarUrl: null,
  providerUserId: "sub-alice-home",
  providerId: "fake",
};
const ALICE_WORK: AuthProfile = {
  email: Email("alice@work.co"),
  name: "Alice (work)",
  avatarUrl: null,
  providerUserId: "sub-alice-work",
  providerId: "fake",
};
const STRANGER: AuthProfile = {
  email: Email("stranger@example.com"),
  name: "Stranger",
  avatarUrl: null,
  providerUserId: "sub-stranger",
  providerId: "fake",
};

let authProvider: InMemoryAuthProvider;
let users: InMemoryUserRepository;
let persons: InMemoryPersonRepository;
let linkAttempts: InMemoryLinkAttemptStore;
let clock: FixedClock;
const ALICE_PERSON = PersonId(uuid(1));
const STRANGER_PERSON = PersonId(uuid(2));

beforeEach(() => {
  authProvider = new InMemoryAuthProvider(
    new Map([
      ["alice-work-code", ALICE_WORK],
      ["stranger-code", STRANGER],
      ["alice-home-code", ALICE_HOME],
    ]),
  );
  users = new InMemoryUserRepository();
  persons = new InMemoryPersonRepository();
  linkAttempts = new InMemoryLinkAttemptStore();
  clock = new FixedClock(new Date("2026-04-18T00:00:00Z"));
});

describe("beginLink", () => {
  it("mints a state, stores an attempt, and returns an authorize URL", async () => {
    const { state, authorizeUrl } = await beginLink(
      { authProvider, linkAttempts, clock },
      {
        initiatingPersonId: ALICE_PERSON,
        redirectUri: "http://api.test/auth/link/callback",
      },
    );
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(authorizeUrl).toContain(encodeURIComponent("http://api.test/"));
    // attempt exists in the store
    const stored = await linkAttempts.consume(state);
    expect(stored).not.toBeNull();
    expect(stored!.initiatingPersonId).toBe(ALICE_PERSON);
  });

  it("expiry defaults to 10 minutes", async () => {
    const { state } = await beginLink(
      { authProvider, linkAttempts, clock },
      {
        initiatingPersonId: ALICE_PERSON,
        redirectUri: "http://api.test/cb",
      },
    );
    const stored = await linkAttempts.consume(state);
    expect(stored!.expiresAt.getTime() - clock.now().getTime()).toBe(
      10 * 60 * 1000,
    );
  });
});

describe("completeLink", () => {
  async function startLink() {
    return beginLink(
      { authProvider, linkAttempts, clock },
      {
        initiatingPersonId: ALICE_PERSON,
        redirectUri: "http://api.test/cb",
      },
    );
  }

  it("upserts the new user and attaches to the initiating person", async () => {
    const { state } = await startLink();
    const result = await completeLink(
      {
        authProvider,
        users,
        persons,
        linkAttempts,
        clock,
        allowedDomains: [],
      },
      { state, code: "alice-work-code", redirectUri: "http://api.test/cb" },
    );
    expect(result.linkedUser.email).toBe(Email("alice@work.co"));
    const pid = await persons.findPersonIdForUser(result.linkedUser.id);
    expect(pid).toBe(ALICE_PERSON);
  });

  it("rejects a state that was never stored", async () => {
    await expect(
      completeLink(
        {
          authProvider,
          users,
          persons,
          linkAttempts,
          clock,
          allowedDomains: [],
        },
        {
          state: LinkState("never-minted"),
          code: "alice-work-code",
          redirectUri: "http://api.test/cb",
        },
      ),
    ).rejects.toBeInstanceOf(LinkAttemptNotFoundError);
  });

  it("rejects an expired attempt", async () => {
    const { state } = await startLink();
    clock.advance(20 * 60 * 1000);
    await expect(
      completeLink(
        {
          authProvider,
          users,
          persons,
          linkAttempts,
          clock,
          allowedDomains: [],
        },
        { state, code: "alice-work-code", redirectUri: "http://api.test/cb" },
      ),
    ).rejects.toBeInstanceOf(LinkAttemptExpiredError);
  });

  it("rejects cross-person link (email already tied to another person)", async () => {
    // Seed: stranger@example.com already belongs to STRANGER_PERSON
    persons.seed(
      Email("stranger@example.com"),
      UserId(uuid(99)),
      STRANGER_PERSON,
    );

    const { state } = await startLink();
    await expect(
      completeLink(
        {
          authProvider,
          users,
          persons,
          linkAttempts,
          clock,
          allowedDomains: [],
        },
        { state, code: "stranger-code", redirectUri: "http://api.test/cb" },
      ),
    ).rejects.toBeInstanceOf(CrossPersonLinkError);
  });

  it("is idempotent when the email already belongs to the SAME person", async () => {
    // Seed: alice@example.com -> ALICE_PERSON, then try to re-link alice@example.com
    persons.seed(
      Email("alice@example.com"),
      UserId(uuid(50)),
      ALICE_PERSON,
    );
    const { state } = await startLink();
    const result = await completeLink(
      {
        authProvider,
        users,
        persons,
        linkAttempts,
        clock,
        allowedDomains: [],
      },
      { state, code: "alice-home-code", redirectUri: "http://api.test/cb" },
    );
    const pid = await persons.findPersonIdForUser(result.linkedUser.id);
    expect(pid).toBe(ALICE_PERSON);
  });

  it("single-use: a state consumed once cannot be reused", async () => {
    const { state } = await startLink();
    await completeLink(
      {
        authProvider,
        users,
        persons,
        linkAttempts,
        clock,
        allowedDomains: [],
      },
      { state, code: "alice-work-code", redirectUri: "http://api.test/cb" },
    );
    // re-use the same state
    authProvider = new InMemoryAuthProvider(
      new Map([["alice-work-code", ALICE_WORK]]),
    );
    await expect(
      completeLink(
        {
          authProvider,
          users,
          persons,
          linkAttempts,
          clock,
          allowedDomains: [],
        },
        { state, code: "alice-work-code", redirectUri: "http://api.test/cb" },
      ),
    ).rejects.toBeInstanceOf(LinkAttemptNotFoundError);
  });
});
