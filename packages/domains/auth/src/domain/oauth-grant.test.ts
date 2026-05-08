import { describe, expect, it } from "bun:test";
import { hasGrantedScopes } from "./oauth-grant.js";

describe("hasGrantedScopes", () => {
  it("returns true when no scopes are requested", () => {
    expect(hasGrantedScopes([], [])).toBe(true);
    expect(
      hasGrantedScopes(["scope-a"], []),
    ).toBe(true);
  });

  it("returns true when every requested scope is present", () => {
    expect(
      hasGrantedScopes(
        [
          "https://www.googleapis.com/auth/drive.readonly",
          "openid",
          "email",
        ],
        ["https://www.googleapis.com/auth/drive.readonly"],
      ),
    ).toBe(true);
  });

  it("returns false when any requested scope is missing", () => {
    expect(
      hasGrantedScopes(
        ["openid", "email"],
        ["https://www.googleapis.com/auth/drive.readonly"],
      ),
    ).toBe(false);
  });

  it("requires the exact scope string — does not loosen on prefix", () => {
    // Critical: drive.readonly is NOT satisfied by drive.file or drive.
    // Prefix-style satisfaction would be a security regression — would
    // let an agent that asked for drive.file get a token usable on
    // every file the user owns.
    expect(
      hasGrantedScopes(
        ["https://www.googleapis.com/auth/drive.file"],
        ["https://www.googleapis.com/auth/drive.readonly"],
      ),
    ).toBe(false);
  });

  it("treats granted as a set — duplicates and order are irrelevant", () => {
    expect(
      hasGrantedScopes(
        ["openid", "openid", "email"],
        ["email", "openid"],
      ),
    ).toBe(true);
  });
});
