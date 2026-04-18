import { describe, it, expect } from "bun:test";
import { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import { InMemorySessionTokenizer } from "./fakes.js";
import { verifySessionToken } from "./verify-session.js";
import { SessionVerificationError } from "../domain/errors.js";
import type { AuthSession } from "../domain/auth-session.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

const session: AuthSession = {
  userId: UserId(uuid),
  email: Email("alice@example.com"),
  name: "Alice",
  memberships: [
    {
      workspaceId: WorkspaceId(uuid),
      slug: "default",
      name: "Default",
      role: Role("owner"),
    },
  ],
  isPlatformAdmin: false,
};

describe("verifySessionToken", () => {
  it("round-trips a signed session", () => {
    const tokenizer = new InMemorySessionTokenizer();
    const token = tokenizer.sign(session);
    expect(verifySessionToken(tokenizer, token).userId).toBe(session.userId);
  });

  it("throws on garbage tokens", () => {
    const tokenizer = new InMemorySessionTokenizer();
    expect(() => verifySessionToken(tokenizer, "nope")).toThrow(
      SessionVerificationError,
    );
  });
});
