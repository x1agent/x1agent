import { describe, it, expect } from "bun:test";
import { Email, Role, UserId, WorkspaceId } from "@x1agent/kernel";
import { JwtSessionTokenizer } from "./jwt-session-tokenizer.js";
import type { AuthSession } from "../../domain/auth-session.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

function session(): AuthSession {
  return {
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
}

describe("JwtSessionTokenizer", () => {
  it("round-trips sign and verify", () => {
    const t = new JwtSessionTokenizer({ secret: "test-secret" });
    const token = t.sign(session());
    const decoded = t.verify(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.email).toBe(session().email);
    expect(decoded!.memberships).toHaveLength(1);
    expect(decoded!.memberships[0]!.slug).toBe("default");
  });

  it("returns null for a token signed with a different secret", () => {
    const a = new JwtSessionTokenizer({ secret: "one" });
    const b = new JwtSessionTokenizer({ secret: "two" });
    expect(b.verify(a.sign(session()))).toBeNull();
  });

  it("returns null for garbage input", () => {
    const t = new JwtSessionTokenizer({ secret: "s" });
    expect(t.verify("nope")).toBeNull();
    expect(t.verify("")).toBeNull();
  });

  it("honors expiresIn", async () => {
    const t = new JwtSessionTokenizer({ secret: "s", expiresIn: "1ms" });
    const token = t.sign(session());
    await new Promise((r) => setTimeout(r, 20));
    expect(t.verify(token)).toBeNull();
  });
});
