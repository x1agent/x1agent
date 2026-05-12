import { describe, it, expect } from "bun:test";
import { selectSessionModel } from "./job-watcher.js";

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
      selectSessionModel(
        { modelOverride: null },
        { model: null },
        undefined,
      ),
    ).toBeUndefined();
  });
});
