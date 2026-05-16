import { describe, it, expect } from "bun:test";
import { UserId, type Email } from "@x1agent/kernel";
import type { User, UserRepository } from "@x1agent/domain-auth";
import { EmailListPlatformAdminGuard } from "./platform-admin-guard.js";

/**
 * Guard is small (one method) but it's the visibility-bypass boundary
 * — a regression silently exposes every workspace's session list to
 * an admin who shouldn't see it. Four cases cover the meaningful
 * branches.
 */

const ALICE = UserId("00000000-0000-7000-8000-00000000a1ce");
const BOB = UserId("00000000-0000-7000-8000-00000000b0b0");

function makeUser(id: ReturnType<typeof UserId>, email: string): User {
  return {
    id,
    email: email as Email,
    name: null,
    createdAt: new Date(),
  } as User;
}

function fakeUsers(rows: User[]): UserRepository {
  const byId = new Map(rows.map((u) => [u.id, u]));
  return {
    async findById(id) {
      return byId.get(id) ?? null;
    },
  } as UserRepository;
}

describe("EmailListPlatformAdminGuard", () => {
  it("empty admin list → no one is platform admin", async () => {
    const guard = new EmailListPlatformAdminGuard(
      [],
      fakeUsers([makeUser(ALICE, "alice@x1agent.com")]),
    );
    expect(await guard.isPlatformAdmin(ALICE)).toBe(false);
  });

  it("listed email (case-insensitive) → true", async () => {
    const guard = new EmailListPlatformAdminGuard(
      ["Alice@X1Agent.com"],
      fakeUsers([makeUser(ALICE, "alice@x1agent.com")]),
    );
    expect(await guard.isPlatformAdmin(ALICE)).toBe(true);
  });

  it("user email differs in case but matches the configured admin → true", async () => {
    // Defence in depth: the user row might have been written with
    // mixed-case email at registration time. Compare lower-cased
    // both sides so neither side relies on the other being
    // canonicalised.
    const guard = new EmailListPlatformAdminGuard(
      ["alice@x1agent.com"],
      fakeUsers([makeUser(ALICE, "Alice@X1Agent.com")]),
    );
    expect(await guard.isPlatformAdmin(ALICE)).toBe(true);
  });

  it("user not in repo → false (defensive: don't bypass on unknown actor)", async () => {
    const guard = new EmailListPlatformAdminGuard(
      ["alice@x1agent.com"],
      fakeUsers([]),
    );
    expect(await guard.isPlatformAdmin(ALICE)).toBe(false);
  });

  it("user exists but email is not in the admin list → false", async () => {
    const guard = new EmailListPlatformAdminGuard(
      ["alice@x1agent.com"],
      fakeUsers([makeUser(BOB, "bob@x1agent.com")]),
    );
    expect(await guard.isPlatformAdmin(BOB)).toBe(false);
  });
});
