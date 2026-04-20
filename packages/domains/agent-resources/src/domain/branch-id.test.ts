import { describe, expect, it } from "bun:test";
import { branchId } from "./branch-id.js";

describe("branchId", () => {
  it("sanitizes slashes and other non-alnum characters", () => {
    const id = branchId("acme/api", "feat/new-api");
    expect(id).toMatch(/^api_feat_new_api_[0-9a-f]{8}$/);
  });

  it("distinguishes branches that collide after sanitization", () => {
    const a = branchId("acme/api", "feat/x-y");
    const b = branchId("acme/api", "feat-x_y");
    const [_prefixA, hashA] = a.match(/^(.+)_([0-9a-f]{8})$/)!.slice(1);
    const [_prefixB, hashB] = b.match(/^(.+)_([0-9a-f]{8})$/)!.slice(1);
    expect(hashA).not.toBe(hashB);
  });

  it("is stable for the same input", () => {
    expect(branchId("acme/api", "main")).toBe(branchId("acme/api", "main"));
  });

  it("distinguishes the same repo name from different owners", () => {
    // Workspace may link acme/api and beta/api as two separate repos;
    // their branch DBs must not collide.
    expect(branchId("acme/api", "main")).not.toBe(
      branchId("beta/api", "main"),
    );
  });

  it("stays within 63 bytes for pathological inputs", () => {
    const long = "really-long-branch-name-that-exceeds-reasonable-lengths-and-keeps-going";
    const id = branchId("org/service-with-a-long-repo-name", long);
    expect(id.length).toBeLessThanOrEqual(63);
  });

  it("produces lowercase identifiers", () => {
    const id = branchId("acme/API", "Feat/UPPER");
    expect(id).toBe(id.toLowerCase());
  });
});
