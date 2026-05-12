/**
 * Platform-wide LLM provider credentials surfaced through Admin
 * Settings → LLM Provider Keys (X1A-46). The contract is deliberately
 * tight: callers see only whether a key is configured, never the value.
 *
 * "Provider" is the public identifier the UI uses to address a key —
 * one entry per provider card in the mockup. Adding a new provider
 * means extending this list AND the helm chart's env: entries, so the
 * api pod actually picks up the new env var on rollout.
 */
export type LlmProvider = "anthropic" | "openai";

export const LLM_PROVIDERS: readonly LlmProvider[] = ["anthropic", "openai"];

/**
 * Map from public provider id to the process.env variable name the api
 * (and every downstream agent SDK) reads at runtime. Keeping this in
 * one place lets the status check, the K8s Secret writer, and the
 * envFrom contract in helm all agree on naming.
 */
export const LLM_PROVIDER_ENV: Record<LlmProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export interface LlmProviderStatus {
  provider: LlmProvider;
  /** True iff the api pod currently has a non-empty value for this key. */
  configured: boolean;
}

export interface LlmKeysStatusResponse {
  providers: readonly LlmProviderStatus[];
}
