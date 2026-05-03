import { describe, it, expect } from "bun:test";
import { validateManifest } from "./manifest.js";
import { ValidationError } from "@x1agent/kernel";

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const m = validateManifest({ env: {}, tool_scopes: {} });
    expect(m.env).toEqual({});
    expect(m.tool_scopes).toEqual({});
  });

  it("accepts a fully-populated manifest", () => {
    const m = validateManifest({
      env: {
        LINEAR_API_KEY: { kind: "secret", label: "API key", required: true },
        LINEAR_TEAM_ID: { kind: "value", required: false, description: "team id" },
      },
      tool_scopes: {
        create_issue: ["linear.write"],
        search_issues: ["linear.read"],
        ping: [],
      },
    });
    expect(m.env.LINEAR_API_KEY?.kind).toBe("secret");
    expect(m.env.LINEAR_TEAM_ID?.required).toBe(false);
    expect(m.tool_scopes.create_issue).toEqual(["linear.write"]);
    expect(m.tool_scopes.ping).toEqual([]);
  });

  it("defaults required to true when omitted", () => {
    const m = validateManifest({
      env: { X: { kind: "value" } },
      tool_scopes: {},
    });
    expect(m.env.X?.required).toBe(true);
  });

  it("rejects non-object root", () => {
    for (const raw of [null, "string", 42, [], true]) {
      expect(() => validateManifest(raw)).toThrow(ValidationError);
    }
  });

  it("rejects missing env", () => {
    expect(() => validateManifest({ tool_scopes: {} })).toThrow(ValidationError);
  });

  it("rejects bad env-var name", () => {
    expect(() =>
      validateManifest({
        env: { "lower-case": { kind: "secret" } },
        tool_scopes: {},
      }),
    ).toThrow(ValidationError);
  });

  it("rejects bad env kind", () => {
    expect(() =>
      validateManifest({
        env: { X: { kind: "weird" } },
        tool_scopes: {},
      }),
    ).toThrow(ValidationError);
  });

  it("rejects non-array tool_scopes value", () => {
    expect(() =>
      validateManifest({ env: {}, tool_scopes: { foo: "linear.read" } }),
    ).toThrow(ValidationError);
  });

  it("rejects non-string tool_scopes element", () => {
    expect(() =>
      validateManifest({ env: {}, tool_scopes: { foo: [1, 2] } }),
    ).toThrow(ValidationError);
  });
});
