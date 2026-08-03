import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import {
  GrantScope,
  GrantType,
  InvalidGrantShapeError,
  isGrantActive,
} from "./grant.js";
import {
  SPAWN_GRANT_TYPE,
  validateSpawnDetails,
} from "./details/spawn.js";
import {
  TOOL_SCOPE_GRANT_TYPE,
  validateToolScopeDetails,
} from "./details/tool-scope.js";
import {
  listRegisteredGrantTypes,
  validateGrantDetails,
} from "./details/registry.js";

describe("GrantScope", () => {
  it.each(["once", "session", "persistent"])("accepts %p", (s) => {
    expect(GrantScope(s)).toBe(s);
  });

  it.each(["forever", "", "ONCE", "always"])("rejects %p", (s) => {
    expect(() => GrantScope(s)).toThrow(ValidationError);
  });
});

describe("GrantType", () => {
  it.each(["spawn", "tool_scope", "custom_feature_v2"])("accepts %p", (s) => {
    expect(GrantType(s)).toBe(s);
  });

  it.each([
    "Spawn",
    "tool-scope",
    "",
    "123abc",
    "spawn.thing",
    "tool scope",
  ])("rejects %p", (s) => {
    expect(() => GrantType(s)).toThrow(ValidationError);
  });
});

describe("isGrantActive", () => {
  const base = {
    consumedAt: null as Date | null,
    revokedAt: null as Date | null,
  };
  it("returns true when neither consumed nor revoked", () => {
    expect(isGrantActive({ ...base } as never)).toBe(true);
  });
  it("returns false when consumed", () => {
    expect(
      isGrantActive({ ...base, consumedAt: new Date() } as never),
    ).toBe(false);
  });
  it("returns false when revoked", () => {
    expect(
      isGrantActive({ ...base, revokedAt: new Date() } as never),
    ).toBe(false);
  });
});

describe("spawn details validator", () => {
  const goodUuid = "019da258-70a0-7efa-98a1-47cdc5f9e001";

  it("accepts a uuid", () => {
    expect(validateSpawnDetails({ child_agent_id: goodUuid })).toEqual({
      child_agent_id: goodUuid,
    } as never);
  });

  it("accepts runtime and model allowlists", () => {
    expect(
      validateSpawnDetails({
        child_agent_id: goodUuid,
        allowed_runtime_types: ["claude_code", "codex"],
        allowed_models: ["gpt-5-codex", "claude-sonnet-4-5@20250929"],
      }),
    ).toMatchObject({
      child_agent_id: goodUuid,
      allowed_runtime_types: ["claude_code", "codex"],
      allowed_models: ["gpt-5-codex", "claude-sonnet-4-5@20250929"],
    });
  });

  it("rejects unsupported runtime allowlists", () => {
    expect(() =>
      validateSpawnDetails({
        child_agent_id: goodUuid,
        allowed_runtime_types: ["opencode"],
      }),
    ).toThrow(InvalidGrantShapeError);
  });

  it("rejects non-object", () => {
    expect(() => validateSpawnDetails(null)).toThrow(InvalidGrantShapeError);
    expect(() => validateSpawnDetails("str")).toThrow(InvalidGrantShapeError);
  });

  it("rejects missing child_agent_id", () => {
    expect(() => validateSpawnDetails({})).toThrow(InvalidGrantShapeError);
  });

  it("rejects non-uuid child_agent_id", () => {
    expect(() => validateSpawnDetails({ child_agent_id: "not-a-uuid" }))
      .toThrow(InvalidGrantShapeError);
  });

  it("rejects unknown extra fields", () => {
    expect(() =>
      validateSpawnDetails({ child_agent_id: goodUuid, evil: true }),
    ).toThrow(InvalidGrantShapeError);
  });
});

describe("tool_scope details validator", () => {
  it.each(["git.write", "gmail.read", "calendar.write", "a.b.c"])(
    "accepts %p",
    (s) => {
      expect(validateToolScopeDetails({ scope: s })).toEqual({
        scope: s,
      });
    },
  );

  it.each(["git", "Git.write", "git write", "", "git."])(
    "rejects %p",
    (s) => {
      expect(() => validateToolScopeDetails({ scope: s })).toThrow(
        InvalidGrantShapeError,
      );
    },
  );

  it("rejects missing scope", () => {
    expect(() => validateToolScopeDetails({})).toThrow(InvalidGrantShapeError);
  });

  it("rejects unknown extra fields", () => {
    expect(() =>
      validateToolScopeDetails({ scope: "git.write", extra: 1 }),
    ).toThrow(InvalidGrantShapeError);
  });
});

describe("registry", () => {
  it("lists built-in types", () => {
    const types = listRegisteredGrantTypes();
    expect(types).toContain(SPAWN_GRANT_TYPE);
    expect(types).toContain(TOOL_SCOPE_GRANT_TYPE);
  });

  it("validateGrantDetails rejects unknown type", () => {
    expect(() =>
      validateGrantDetails(GrantType("totally_fake"), {}),
    ).toThrow(InvalidGrantShapeError);
  });

  it("validateGrantDetails delegates to registered validator", () => {
    const out = validateGrantDetails(GrantType(TOOL_SCOPE_GRANT_TYPE), {
      scope: "git.write",
    });
    expect(out).toEqual({ scope: "git.write" });
  });
});
