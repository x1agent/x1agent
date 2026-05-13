import type { Clock } from "@x1agent/kernel";
import type { RateLimiter } from "../ports/rate-limiter.js";

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Fixed-window in-memory rate limiter. Adequate for v1 — every api
 * pod has its own bucket map. Replace with Redis once we run > 1 api
 * replica that share a per-user budget.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly clock: Clock) {}

  async tryConsume(
    key: string,
    max: number,
    windowMs: number,
  ): Promise<boolean> {
    const now = this.clock.now().getTime();
    const cur = this.buckets.get(key);
    if (!cur || now - cur.windowStart >= windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (cur.count >= max) return false;
    cur.count += 1;
    return true;
  }
}
