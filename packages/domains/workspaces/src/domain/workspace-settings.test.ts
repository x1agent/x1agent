import { describe, expect, test } from "bun:test";
import {
  parseWorkspaceSettings,
  parseWorkspaceSettingsPatch,
  WORKSPACE_SETTINGS_DEFAULTS,
  workspacePermitsOauthOnNonWorkers,
} from "./workspace-settings.js";

describe("parseWorkspaceSettings", () => {
  test("empty object → all defaults", () => {
    expect(parseWorkspaceSettings({})).toEqual({
      ...WORKSPACE_SETTINGS_DEFAULTS,
    });
  });

  test("non-object → defaults", () => {
    expect(parseWorkspaceSettings(null)).toEqual({
      ...WORKSPACE_SETTINGS_DEFAULTS,
    });
    expect(parseWorkspaceSettings("string")).toEqual({
      ...WORKSPACE_SETTINGS_DEFAULTS,
    });
    expect(parseWorkspaceSettings(42)).toEqual({
      ...WORKSPACE_SETTINGS_DEFAULTS,
    });
  });

  test("decodes valid mode values", () => {
    expect(
      parseWorkspaceSettings({ oauthMcpsOnOrchestrators: "off" })
        .oauthMcpsOnOrchestrators,
    ).toBe("off");
    expect(
      parseWorkspaceSettings({ oauthMcpsOnOrchestrators: "on_attended" })
        .oauthMcpsOnOrchestrators,
    ).toBe("on_attended");
    expect(
      parseWorkspaceSettings({ oauthMcpsOnOrchestrators: "on" })
        .oauthMcpsOnOrchestrators,
    ).toBe("on");
  });

  test("administrative MCP is restrictive by default and decodes booleans", () => {
    expect(parseWorkspaceSettings({}).adminMcpEnabled).toBe(false);
    expect(
      parseWorkspaceSettings({ adminMcpEnabled: true }).adminMcpEnabled,
    ).toBe(true);
    expect(
      parseWorkspaceSettings({ adminMcpEnabled: "true" }).adminMcpEnabled,
    ).toBe(false);
  });

  test("unknown mode string falls back to default", () => {
    expect(
      parseWorkspaceSettings({ oauthMcpsOnOrchestrators: "yolo" })
        .oauthMcpsOnOrchestrators,
    ).toBe(WORKSPACE_SETTINGS_DEFAULTS.oauthMcpsOnOrchestrators);
  });

  test("wrong-typed mode value falls back to default", () => {
    expect(
      parseWorkspaceSettings({ oauthMcpsOnOrchestrators: true })
        .oauthMcpsOnOrchestrators,
    ).toBe(WORKSPACE_SETTINGS_DEFAULTS.oauthMcpsOnOrchestrators);
    expect(
      parseWorkspaceSettings({ oauthMcpsOnOrchestrators: 1 })
        .oauthMcpsOnOrchestrators,
    ).toBe(WORKSPACE_SETTINGS_DEFAULTS.oauthMcpsOnOrchestrators);
  });

  test("ignores unknown keys", () => {
    const out = parseWorkspaceSettings({
      oauthMcpsOnOrchestrators: "on_attended",
      futureKey: "anything",
    });
    expect(out).toEqual({
      oauthMcpsOnOrchestrators: "on_attended",
      adminMcpEnabled: false,
    });
  });
});

describe("parseWorkspaceSettingsPatch", () => {
  test("empty patch → empty out", () => {
    expect(parseWorkspaceSettingsPatch({})).toEqual({});
  });

  test("valid mode → echoed", () => {
    expect(
      parseWorkspaceSettingsPatch({ oauthMcpsOnOrchestrators: "on" }),
    ).toEqual({
      oauthMcpsOnOrchestrators: "on",
    });
  });

  test("valid administrative MCP boolean → echoed", () => {
    expect(parseWorkspaceSettingsPatch({ adminMcpEnabled: true })).toEqual({
      adminMcpEnabled: true,
    });
  });

  test("invalid mode string → dropped", () => {
    expect(
      parseWorkspaceSettingsPatch({ oauthMcpsOnOrchestrators: "yolo" }),
    ).toEqual({});
  });

  test("wrong-typed mode → dropped", () => {
    expect(
      parseWorkspaceSettingsPatch({ oauthMcpsOnOrchestrators: true }),
    ).toEqual({});
  });

  test("unknown keys → stripped", () => {
    expect(
      parseWorkspaceSettingsPatch({
        oauthMcpsOnOrchestrators: "off",
        futureKey: "ignore me",
      }),
    ).toEqual({ oauthMcpsOnOrchestrators: "off" });
  });

  test("non-object → empty out (no throw)", () => {
    expect(parseWorkspaceSettingsPatch(null)).toEqual({});
    expect(parseWorkspaceSettingsPatch(42)).toEqual({});
    expect(parseWorkspaceSettingsPatch("hi")).toEqual({});
  });
});

describe("workspacePermitsOauthOnNonWorkers", () => {
  test("off → false", () => {
    expect(
      workspacePermitsOauthOnNonWorkers({
        oauthMcpsOnOrchestrators: "off",
        adminMcpEnabled: false,
      }),
    ).toBe(false);
  });
  test("on_attended → true", () => {
    expect(
      workspacePermitsOauthOnNonWorkers({
        oauthMcpsOnOrchestrators: "on_attended",
        adminMcpEnabled: false,
      }),
    ).toBe(true);
  });
  test("on → true", () => {
    expect(
      workspacePermitsOauthOnNonWorkers({
        oauthMcpsOnOrchestrators: "on",
        adminMcpEnabled: false,
      }),
    ).toBe(true);
  });
});
