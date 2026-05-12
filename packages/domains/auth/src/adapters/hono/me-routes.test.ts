import { describe, it, expect, beforeEach } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { Email, UserId } from "@x1agent/kernel";
import { createMeRoutes } from "./me-routes.js";
import type { UserRepository } from "../../ports/user-repository.js";
import type { User } from "../../domain/user.js";
import type { GitIdentity } from "../../domain/git-identity.js";

/**
 * Route-layer integration tests for /api/me/git-identity.
 *
 * The DB / repository contract is exercised by the postgres adapter
 * tests; here we pin the auth surface (must require a session, only
 * touches the session's own userId, validation errors map to 400 with
 * the field name, and DELETE clears the columns).
 */

const ALICE = UserId("00000000-0000-7000-8000-00000000aaaa");
const BOB = UserId("00000000-0000-7000-8000-00000000bbbb");

class FakeUsers implements UserRepository {
  private byId = new Map<string, User>();
  /** Catches who setGitIdentity was called for. */
  public lastWrite: { userId: string; identity: GitIdentity | null } | null =
    null;

  seed(u: User) {
    this.byId.set(u.id, u);
  }

  async findById(id: UserId): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }
  async findByEmail(): Promise<User | null> {
    return null;
  }
  async upsertFromProfile(): Promise<User> {
    throw new Error("not used");
  }
  async listMemberships() {
    return [];
  }
  async setGitIdentity(userId: UserId, identity: GitIdentity | null) {
    this.lastWrite = { userId, identity };
    const u = this.byId.get(userId);
    if (u) this.byId.set(userId, { ...u, gitIdentity: identity });
  }
}

function makeRoutes(opts: {
  users: FakeUsers;
  /** When set, requireAuth seeds this userId; otherwise returns 401. */
  sessionUserId?: string;
}) {
  const requireAuth: MiddlewareHandler = async (c, next) => {
    if (!opts.sessionUserId) return c.json({ error: "unauthenticated" }, 401);
    c.set("session", {
      userId: opts.sessionUserId,
      email: "alice@example.com",
      name: "Alice",
      memberships: [],
      isPlatformAdmin: false,
    } as never);
    await next();
  };
  const app = new Hono();
  app.route("/api/me", createMeRoutes({ users: opts.users, requireAuth }));
  return app;
}

let users: FakeUsers;

beforeEach(() => {
  users = new FakeUsers();
  users.seed({
    id: ALICE,
    email: Email("alice@example.com"),
    name: "Alice",
    avatarUrl: null,
    isActive: true,
    gitIdentity: null,
  });
  users.seed({
    id: BOB,
    email: Email("bob@example.com"),
    name: "Bob",
    avatarUrl: null,
    isActive: true,
    gitIdentity: { name: "Bob", email: "bob@example.com" },
  });
});

describe("GET /api/me/git-identity", () => {
  it("requires a session", async () => {
    const app = makeRoutes({ users });
    const res = await app.request("/api/me/git-identity");
    expect(res.status).toBe(401);
  });

  it("returns null when the user has no identity set", async () => {
    const app = makeRoutes({ users, sessionUserId: ALICE });
    const res = await app.request("/api/me/git-identity");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ git_identity: null });
  });

  it("returns the user's own identity when set", async () => {
    const app = makeRoutes({ users, sessionUserId: BOB });
    const res = await app.request("/api/me/git-identity");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      git_identity: { name: "Bob", email: "bob@example.com" },
    });
  });

  it("only ever reads the SESSION user — Alice cannot see Bob via path tampering", async () => {
    // The route has no path param at all — it always reads
    // session.userId. This test pins that contract by asserting the
    // body is Alice's even though Bob has a populated identity.
    const app = makeRoutes({ users, sessionUserId: ALICE });
    const res = await app.request("/api/me/git-identity");
    expect(await res.json()).toEqual({ git_identity: null });
  });
});

describe("PUT /api/me/git-identity", () => {
  it("writes the identity for the SESSION user only", async () => {
    const app = makeRoutes({ users, sessionUserId: ALICE });
    const res = await app.request("/api/me/git-identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice", email: "alice@github.com" }),
    });
    expect(res.status).toBe(200);
    expect(users.lastWrite?.userId).toBe(ALICE);
    expect(users.lastWrite?.identity).toEqual({
      name: "Alice",
      email: "alice@github.com",
    });
  });

  it("returns 400 with field=git_email on bad email", async () => {
    const app = makeRoutes({ users, sessionUserId: ALICE });
    const res = await app.request("/api/me/git-identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice", email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("git_email");
  });

  it("returns 400 when fields are missing", async () => {
    const app = makeRoutes({ users, sessionUserId: ALICE });
    const res = await app.request("/api/me/git-identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@github.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires a session", async () => {
    const app = makeRoutes({ users });
    const res = await app.request("/api/me/git-identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", email: "x@example.com" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/me/git-identity", () => {
  it("clears the SESSION user's identity", async () => {
    const app = makeRoutes({ users, sessionUserId: BOB });
    const res = await app.request("/api/me/git-identity", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(users.lastWrite).toEqual({ userId: BOB, identity: null });
  });
});
