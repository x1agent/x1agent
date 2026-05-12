import { describe, it, expect } from "bun:test";
import { llmKeysStatus, singleStatus } from "./status.js";

describe("llmKeysStatus", () => {
  it("reports both providers as not_configured on an empty env", () => {
    const out = llmKeysStatus({});
    expect(out.providers).toEqual([
      { provider: "anthropic", configured: false },
      { provider: "openai", configured: false },
    ]);
  });

  it("reports configured when a key has a non-empty value", () => {
    const out = llmKeysStatus({
      ANTHROPIC_API_KEY: "sk-ant-abc",
      OPENAI_API_KEY: "sk-xyz",
    });
    expect(out.providers).toEqual([
      { provider: "anthropic", configured: true },
      { provider: "openai", configured: true },
    ]);
  });

  it("treats the ESO/gcloud single-newline placeholder as not_configured", () => {
    // gcloud secrets versions add rejects an empty stdin payload, so the
    // installer pushes "\n" when no value is set. The api pod sees "\n"
    // in the env; the user-facing badge must NOT call that "configured".
    const out = llmKeysStatus({ ANTHROPIC_API_KEY: "\n", OPENAI_API_KEY: "" });
    expect(out.providers).toEqual([
      { provider: "anthropic", configured: false },
      { provider: "openai", configured: false },
    ]);
  });

  it("ignores leading/trailing whitespace when judging emptiness", () => {
    expect(llmKeysStatus({ ANTHROPIC_API_KEY: "   " }).providers).toEqual([
      { provider: "anthropic", configured: false },
      { provider: "openai", configured: false },
    ]);
  });

  it("never echoes the value — even with a key, the response only contains booleans", () => {
    // Regression guard: this is the load-bearing security property of
    // the status endpoint. If someone refactors and accidentally leaks
    // the value, this test must catch it.
    const out = llmKeysStatus({ ANTHROPIC_API_KEY: "sk-ant-secret-12345" });
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-ant-secret-12345");
    expect(json).not.toContain("sk-ant");
  });
});

describe("singleStatus", () => {
  it("returns configured=true only for the named provider's env var", () => {
    const env = { OPENAI_API_KEY: "sk-1" };
    expect(singleStatus(env, "openai")).toEqual({
      provider: "openai",
      configured: true,
    });
    expect(singleStatus(env, "anthropic")).toEqual({
      provider: "anthropic",
      configured: false,
    });
  });
});
