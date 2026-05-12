import {
  LLM_PROVIDERS,
  LLM_PROVIDER_ENV,
  type LlmKeysStatusResponse,
  type LlmProvider,
  type LlmProviderStatus,
} from "./types.js";

/**
 * Pure function: given a snapshot of the process env, return the
 * configured/not-configured status for every LLM provider the platform
 * surfaces. This is the ONLY place the api looks at the actual key
 * value — every other layer trades exclusively in the boolean. Returns
 * false for empty strings and unset vars; true otherwise (the api
 * doesn't try to second-guess key SHAPE here — we ship the v1 contract
 * "user finds out via first failed call" per the greenlit decisions).
 */
export function llmKeysStatus(
  env: Readonly<Record<string, string | undefined>>,
): LlmKeysStatusResponse {
  const providers: LlmProviderStatus[] = LLM_PROVIDERS.map((provider) => ({
    provider,
    configured: hasValue(env[LLM_PROVIDER_ENV[provider]]),
  }));
  return { providers };
}

export function singleStatus(
  env: Readonly<Record<string, string | undefined>>,
  provider: LlmProvider,
): LlmProviderStatus {
  return {
    provider,
    configured: hasValue(env[LLM_PROVIDER_ENV[provider]]),
  };
}

function hasValue(v: string | undefined): boolean {
  if (v === undefined || v === null) return false;
  // External Secrets Operator + gcloud both use "\n" as a non-empty
  // placeholder for "no value yet" — treat a single newline as unset
  // so a freshly-bootstrapped install reads as "not configured"
  // instead of falsely advertising a working key.
  const trimmed = v.trim();
  return trimmed.length > 0;
}
