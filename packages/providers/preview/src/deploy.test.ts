import { describe, it, expect } from "bun:test";
import { imageRefFor, kanikoJobName } from "./deploy.js";

describe("imageRefFor", () => {
  it("builds a registry/previews/<slug>:<shortsha> ref", () => {
    expect(
      imageRefFor(
        "x1-registry.x1agent.svc.cluster.local:5000",
        "hirer-app",
        "abc1234567890abcdef",
      ),
    ).toBe(
      "x1-registry.x1agent.svc.cluster.local:5000/previews/hirer-app:abc123456789",
    );
  });

  it("truncates sha to 12 chars for the tag", () => {
    const r = imageRefFor("r", "s", "1234567890abcdef1234567890");
    expect(r).toBe("r/previews/s:1234567890ab");
  });
});

describe("kanikoJobName", () => {
  it("prefixes + short-sha-suffixes the slug", () => {
    expect(kanikoJobName("hirer-app", "abc1234567890")).toBe(
      "preview-build-hirer-app-abc12345",
    );
  });

  it("clamps to the K8s DNS-1123 label limit (63 chars)", () => {
    const veryLongSlug = "a".repeat(80);
    const name = kanikoJobName(veryLongSlug, "abc12345");
    expect(name.length).toBeLessThanOrEqual(63);
  });
});
