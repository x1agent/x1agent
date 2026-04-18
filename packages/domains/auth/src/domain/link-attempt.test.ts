import { describe, it, expect } from "bun:test";
import { assertNotExpired, LinkState } from "./link-attempt.js";
import { LinkAttemptExpiredError } from "./errors.js";
import { PersonId } from "./person.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

describe("assertNotExpired", () => {
  const attempt = {
    state: LinkState("abc"),
    initiatingPersonId: PersonId(uuid),
    createdAt: new Date("2026-04-18T00:00:00Z"),
    expiresAt: new Date("2026-04-18T00:10:00Z"),
  };

  it("does not throw when now is before expiresAt", () => {
    expect(() =>
      assertNotExpired(attempt, new Date("2026-04-18T00:05:00Z")),
    ).not.toThrow();
  });

  it("throws LinkAttemptExpiredError when now is past expiresAt", () => {
    expect(() =>
      assertNotExpired(attempt, new Date("2026-04-18T00:15:00Z")),
    ).toThrow(LinkAttemptExpiredError);
  });
});
