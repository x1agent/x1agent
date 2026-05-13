import type { UserId } from "@x1agent/kernel";

/**
 * Bucket-style rate limiter port. The composition root supplies an
 * in-memory implementation in dev and (later) a Redis-backed one in
 * prod. Kept as a port so the use case stays free of timer state.
 */
export interface RateLimiter {
  /** Returns true if the caller is under-limit (and consumes a token). */
  tryConsume(key: string, max: number, windowMs: number): Promise<boolean>;
}

export function uploadInitKey(userId: UserId): string {
  return `uploads:init:${userId}`;
}
