import { describe, it, expect } from "bun:test";
import { selectSessionImage, selectSessionModel } from "./job-watcher.js";

/**
 * X1A-40 integration shim — once the orchestrator's spawn passes
 * model: "sonnet" and the api persists the resolved id onto
 * session.modelOverride, the pod-spec layer must read that override
 * first when stamping ANTHROPIC_MODEL onto the agent container.
 *
 * This exercises the precedence rule the job-watcher applies between
 * (session, agent, fallback) at pod-launch time.
 */
describe("selectSessionModel — precedence (X1A-40)", () => {
  it("session.modelOverride wins over agent.model and the fallback", () => {
    expect(
      selectSessionModel(
        { modelOverride: "claude-opus-4-1@20250101" },
        { model: "claude-sonnet-4-5@20250929" },
        "claude-haiku-default",
      ),
    ).toBe("claude-opus-4-1@20250101");
  });

  it("agent.model wins when the session has no override", () => {
    expect(
      selectSessionModel(
        { modelOverride: null },
        { model: "claude-sonnet-4-5@20250929" },
        "claude-haiku-default",
      ),
    ).toBe("claude-sonnet-4-5@20250929");
  });

  it("falls back to the deployment default when neither session nor agent set one", () => {
    expect(
      selectSessionModel(
        { modelOverride: null },
        { model: null },
        "claude-haiku-default",
      ),
    ).toBe("claude-haiku-default");
  });

  it("returns undefined when the whole chain is null/undefined — SDK picks its built-in default", () => {
    expect(
      selectSessionModel({ modelOverride: null }, { model: null }, undefined),
    ).toBeUndefined();
  });

  it("does not carry a Claude agent model into a Codex override", () => {
    expect(
      selectSessionModel(
        { modelOverride: null },
        { model: "sonnet", runtimeType: "claude_code" },
        undefined,
        "codex",
      ),
    ).toBeUndefined();
  });

  it("does not carry a Codex agent model into a Claude override", () => {
    expect(
      selectSessionModel(
        { modelOverride: null },
        { model: "gpt-5.6-sol", runtimeType: "codex" },
        "sonnet",
        "claude_code",
      ),
    ).toBe("sonnet");
  });
});

describe("selectSessionImage — effective runtime image", () => {
  it("uses the Claude runtime image instead of a Codex deployment fallback", () => {
    expect(
      selectSessionImage(
        null,
        "docker.io/x1agent/runtime-core:v1",
        "docker.io/x1agent/runtime-codex:v1",
      ),
    ).toBe("docker.io/x1agent/runtime-core:v1");
  });

  it("uses the Codex runtime image when the effective runtime is Codex", () => {
    expect(
      selectSessionImage(
        null,
        "docker.io/x1agent/runtime-codex:v1",
        "docker.io/x1agent/runtime-core:v1",
      ),
    ).toBe("docker.io/x1agent/runtime-codex:v1");
  });

  it("preserves an explicitly pinned custom toolchain image", () => {
    expect(
      selectSessionImage(
        "registry.example/dev360/getdiffr:v7",
        "docker.io/x1agent/runtime-core:v1",
        "docker.io/x1agent/runtime-codex:v1",
      ),
    ).toBe("registry.example/dev360/getdiffr:v7");
  });

  it("replaces an incompatible platform Codex pin for a Claude override", () => {
    expect(
      selectSessionImage(
        "docker.io/x1agent/runtime-codex:v1",
        "docker.io/x1agent/runtime-core:v1",
        "x1agent-agent:latest",
        {
          pinnedImageName: "runtime-codex",
          pinnedImageIsPlatformPreset: true,
          effectiveRuntime: "claude_code",
        },
      ),
    ).toBe("docker.io/x1agent/runtime-core:v1");
  });

  it("preserves a workspace toolchain image across runtime overrides", () => {
    expect(
      selectSessionImage(
        "registry.example/dev360/getdiffr:v7",
        "docker.io/x1agent/runtime-codex:v1",
        "x1agent-agent:latest",
        {
          pinnedImageName: "getdiffr",
          pinnedImageIsPlatformPreset: false,
          effectiveRuntime: "codex",
        },
      ),
    ).toBe("registry.example/dev360/getdiffr:v7");
  });

  it("falls back to AGENT_IMAGE when the catalog row is missing or empty", () => {
    expect(selectSessionImage("", " ", "x1agent-agent:latest")).toBe(
      "x1agent-agent:latest",
    );
  });
});
