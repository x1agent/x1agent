import { describe, expect, it } from "bun:test";
import {
  createProviderFailureGuard,
  isTerminalProviderError,
  providerFailureMessage,
} from "./provider-failures.js";

describe("provider failure handling", () => {
  it("treats provider authentication failures as immediately terminal", () => {
    expect(
      isTerminalProviderError(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      ),
    ).toBe(true);
    expect(isTerminalProviderError("authentication_failed")).toBe(true);
    expect(isTerminalProviderError("Please run codex login")).toBe(true);
  });

  it("treats invalid or inaccessible model selections as immediately terminal", () => {
    const errors = [
      "model_not_found",
      "invalid model name: claude-future",
      "The model `gpt-future` does not exist or you do not have access to it.",
      "Selected model is unavailable for this account",
      "You do not have access to the requested model",
    ];
    for (const error of errors) {
      const decision = createProviderFailureGuard(3).recordFailure(error);
      expect(decision.terminate).toBe(true);
      expect(decision.reason).toBe("terminal_provider_error");
      expect(decision.consecutiveFailures).toBe(1);
    }
  });

  it("allows transient failures until the consecutive limit", () => {
    const guard = createProviderFailureGuard(3);
    expect(guard.recordFailure("connection reset").terminate).toBe(false);
    expect(guard.recordFailure("upstream unavailable").terminate).toBe(false);
    const third = guard.recordFailure("connection reset");
    expect(third.terminate).toBe(true);
    expect(third.reason).toBe("consecutive_provider_errors");
  });

  it("resets the consecutive count after a successful turn", () => {
    const guard = createProviderFailureGuard(2);
    guard.recordFailure("connection reset");
    guard.recordSuccess();
    expect(guard.recordFailure("connection reset").terminate).toBe(false);
    expect(guard.count()).toBe(1);
  });

  it("redacts tokens from persisted error messages", () => {
    expect(
      providerFailureMessage("Bearer sk-secretvalue123456789 failed"),
    ).toBe("[redacted] failed");
  });
});
