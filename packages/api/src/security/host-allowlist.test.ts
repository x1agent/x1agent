import { describe, expect, test } from "bun:test";
import { buildHostAllowlist } from "./host-allowlist.js";

describe("buildHostAllowlist", () => {
  test("accepts the URL hosts and BASE_DOMAIN", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com", "https://api.example.com"],
      baseDomain: "example.com",
    });
    expect(isAllowed("app.example.com")).toBe(true);
    expect(isAllowed("api.example.com")).toBe(true);
    expect(isAllowed("example.com")).toBe(true);
  });

  test("accepts subdomains of BASE_DOMAIN", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com"],
      baseDomain: "example.com",
    });
    expect(isAllowed("any.example.com")).toBe(true);
    expect(isAllowed("preview.example.com")).toBe(true);
    expect(isAllowed("ws-1.preview.example.com")).toBe(true);
  });

  test("rejects foreign domains", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com"],
      baseDomain: "example.com",
    });
    expect(isAllowed("attacker.com")).toBe(false);
    expect(isAllowed("evil.example.com.attacker.com")).toBe(false);
    expect(isAllowed("example.com.attacker.com")).toBe(false);
  });

  test("rejects empty / missing host", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com"],
      baseDomain: "example.com",
    });
    expect(isAllowed(undefined)).toBe(false);
    expect(isAllowed("")).toBe(false);
  });

  test("strips port before matching", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com"],
      baseDomain: "example.com",
    });
    expect(isAllowed("app.example.com:443")).toBe(true);
    expect(isAllowed("api.example.com:30001")).toBe(true);
  });

  test("accepts localhost / 127.0.0.1 always (kubelet probes, port-forward)", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com"],
      baseDomain: "example.com",
    });
    expect(isAllowed("localhost")).toBe(true);
    expect(isAllowed("localhost:30001")).toBe(true);
    expect(isAllowed("127.0.0.1")).toBe(true);
  });

  test("accepts bare IPv4 (in-cluster Service traffic)", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com"],
      baseDomain: "example.com",
    });
    expect(isAllowed("10.42.0.5")).toBe(true);
    expect(isAllowed("10.42.0.5:30001")).toBe(true);
  });

  test("disabled flag bypasses all checks", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://app.example.com"],
      baseDomain: "example.com",
      disabled: true,
    });
    expect(isAllowed("attacker.com")).toBe(true);
    expect(isAllowed(undefined)).toBe(true);
  });

  test("case-insensitive on Host header", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: ["https://APP.example.com"],
      baseDomain: "Example.com",
    });
    expect(isAllowed("APP.EXAMPLE.COM")).toBe(true);
    expect(isAllowed("app.example.com")).toBe(true);
  });

  test("ignores unparseable URLs without throwing", () => {
    const { hosts } = buildHostAllowlist({
      urls: ["not-a-url", "https://valid.example.com"],
      baseDomain: "example.com",
    });
    expect(hosts).toContain("valid.example.com");
    expect(hosts).toContain("example.com");
  });

  test("local.x1agent.dev — the actual dev setup", () => {
    const { isAllowed } = buildHostAllowlist({
      urls: [
        "https://app.local.x1agent.dev",
        "https://api.local.x1agent.dev",
      ],
      baseDomain: "local.x1agent.dev",
    });
    expect(isAllowed("app.local.x1agent.dev")).toBe(true);
    expect(isAllowed("api.local.x1agent.dev")).toBe(true);
    expect(isAllowed("ws-foo.preview.local.x1agent.dev")).toBe(true);
    expect(isAllowed("evil-rebind.com")).toBe(false);
    expect(isAllowed("attacker-x1agent.dev")).toBe(false); // doesn't end with .local.x1agent.dev
  });
});
