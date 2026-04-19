/**
 * Idle timer for interactive agent sessions.
 *
 * Fires a shutdown callback after a configurable period of no activity.
 * Activity includes: SDK messages, injected user text, and browser
 * presence heartbeats (forwarded by the sidecar as POST /keepalive).
 *
 * During long tool executions the SDK iterator can block for minutes
 * without yielding. A busy watchdog keeps the timer alive whenever the
 * caller flips setBusy(true) — resetting the timer every 60s until the
 * tool call finishes.
 */

export interface IdleTimerCallbacks {
  onTimeout: () => void | Promise<void>;
}

export class IdleTimer {
  private readonly timeoutMs: number;
  private readonly enabledFlag: boolean;
  private readonly callbacks: IdleTimerCallbacks;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private busyFlag = false;

  constructor(timeoutMs: number, enabled: boolean, callbacks: IdleTimerCallbacks) {
    this.timeoutMs = timeoutMs;
    this.enabledFlag = enabled;
    this.callbacks = callbacks;
  }

  /** Restart the countdown. No-op when disabled. */
  reset() {
    if (!this.enabledFlag) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.callbacks.onTimeout();
    }, this.timeoutMs);
  }

  /** Mark the agent busy (tool call in flight). Keeps the timer warm. */
  setBusy(busy: boolean) {
    this.busyFlag = busy;
    if (busy && !this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.busyFlag) this.reset();
      }, 60_000);
    } else if (!busy && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  get busy(): boolean {
    return this.busyFlag;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    this.watchdog = null;
  }
}
