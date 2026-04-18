/**
 * A clock port for time-sensitive domain logic (expiry, rate limits).
 * Injecting the clock lets tests jump time without touching `Date.now()`.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  constructor(private at: Date) {}
  now() {
    return this.at;
  }
  advance(ms: number) {
    this.at = new Date(this.at.getTime() + ms);
  }
  set(at: Date) {
    this.at = at;
  }
}
