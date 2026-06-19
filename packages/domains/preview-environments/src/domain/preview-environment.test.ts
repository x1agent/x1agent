import { describe, expect, it } from "bun:test";
import { isValidAliasHost } from "./preview-environment.js";

describe("isValidAliasHost", () => {
  it("accepts a plain two-label hostname", () => {
    expect(isValidAliasHost("example.com")).toBe(true);
  });

  it("accepts a multi-label hostname", () => {
    expect(isValidAliasHost("app.staging.example.com")).toBe(true);
  });

  it("accepts hostnames with digits + hyphens", () => {
    expect(isValidAliasHost("app-2.acme-co.com")).toBe(true);
  });

  it("rejects single-label hostnames (no public CNAME target)", () => {
    expect(isValidAliasHost("localhost")).toBe(false);
  });

  it("normalizes uppercase input to lowercase before validating (DNS is case-insensitive)", () => {
    // Hostnames are case-insensitive per RFC 1035. The validator
    // accepts mixed case by lowercasing before the regex check —
    // matches what the route layer does on the way in.
    expect(isValidAliasHost("App.Example.com")).toBe(true);
  });

  it("rejects schemes, ports, and paths", () => {
    expect(isValidAliasHost("https://app.example.com")).toBe(false);
    expect(isValidAliasHost("app.example.com:8080")).toBe(false);
    expect(isValidAliasHost("app.example.com/path")).toBe(false);
  });

  it("rejects leading/trailing hyphens in a label", () => {
    expect(isValidAliasHost("-bad.example.com")).toBe(false);
    expect(isValidAliasHost("bad-.example.com")).toBe(false);
  });

  it("rejects empty and whitespace inputs", () => {
    expect(isValidAliasHost("")).toBe(false);
    expect(isValidAliasHost("   ")).toBe(false);
  });

  it("rejects hostnames longer than 253 chars", () => {
    const tooLong = "a".repeat(60) + ".a.a.a.b.c.example.com";
    // Build something > 253
    const padded = (tooLong + ".").repeat(4) + "x.example.com";
    expect(padded.length).toBeGreaterThan(253);
    expect(isValidAliasHost(padded)).toBe(false);
  });

  it("rejects labels longer than 63 chars", () => {
    const longLabel = "a".repeat(64);
    expect(isValidAliasHost(`${longLabel}.example.com`)).toBe(false);
  });

  it("rejects underscores (not RFC 1123 for hostnames)", () => {
    expect(isValidAliasHost("bad_host.example.com")).toBe(false);
  });
});
