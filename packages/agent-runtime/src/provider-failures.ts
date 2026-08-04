const TERMINAL_PROVIDER_ERROR_PATTERNS = [
  /\b401\b/i,
  /unauthori[sz]ed/i,
  /authentication[_ -]?failed/i,
  /oauth[_ -]?org[_ -]?not[_ -]?allowed/i,
  /missing (?:bearer|basic) authentication/i,
  /invalid (?:api[- ]?)?key/i,
  /(?:not|isn't|is not) logged in/i,
  /(?:run|use) .{0,24}\blogin\b/i,
  /credentials? (?:are |is )?(?:missing|expired|invalid|not found)/i,
  /billing[_ -]?error/i,
  /model[_ -]?not[_ -]?found/i,
  /selected model is not supported/i,
  /error_max_(?:turns|budget_usd|structured_output_retries)/i,
];

export interface ProviderFailureDecision {
  terminate: boolean;
  consecutiveFailures: number;
  message: string;
  reason: "terminal_provider_error" | "consecutive_provider_errors" | "retry";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const parts = [value.error, value.message, value.status, value.code]
      .filter((part) => part !== undefined && part !== null)
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)));
    if (parts.length > 0) return parts.join(": ");
  }
  return String(error);
}

export function providerFailureMessage(error: unknown): string {
  const message = errorText(error).trim() || "Provider request failed";
  // Provider errors should be actionable in the timeline, but never echo a
  // bearer/API token if an upstream client included one in its exception.
  return message
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,})\b/gi, "[redacted]")
    .slice(0, 2_000);
}

export function isTerminalProviderError(error: unknown): boolean {
  const message = providerFailureMessage(error);
  return TERMINAL_PROVIDER_ERROR_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

/**
 * Tracks failures across completed provider turns. Explicit auth/configuration
 * failures terminate immediately; unclassified failures get a small retry
 * budget and are reset by the next successful turn.
 */
export function createProviderFailureGuard(maxConsecutiveFailures = 3) {
  const limit = Math.max(1, Math.floor(maxConsecutiveFailures) || 3);
  let consecutiveFailures = 0;

  return {
    recordSuccess(): void {
      consecutiveFailures = 0;
    },

    recordFailure(error: unknown): ProviderFailureDecision {
      consecutiveFailures += 1;
      const message = providerFailureMessage(error);
      if (isTerminalProviderError(message)) {
        return {
          terminate: true,
          consecutiveFailures,
          message,
          reason: "terminal_provider_error",
        };
      }
      if (consecutiveFailures >= limit) {
        return {
          terminate: true,
          consecutiveFailures,
          message,
          reason: "consecutive_provider_errors",
        };
      }
      return {
        terminate: false,
        consecutiveFailures,
        message,
        reason: "retry",
      };
    },

    count(): number {
      return consecutiveFailures;
    },
  };
}
