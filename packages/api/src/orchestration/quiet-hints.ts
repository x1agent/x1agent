/**
 * In-memory "expect quiet" hints from children. A child agent calls
 * the `expect_quiet_for` MCP tool to say "I'll be silent for N
 * seconds, don't worry." The watchdog checks this store before
 * firing; if a hint is active for the child, the watchdog skips it.
 *
 * Not persisted. Losing the store on api restart means a restarted
 * api may fire a spurious watchdog for a legitimately-quiet child.
 * The orchestrator's CLAUDE.md tells it to handle such wakes by
 * glancing at the snapshot and re-waiting; worst case is one extra
 * turn's tokens.
 *
 * See docs/architecture/orchestration.md § Server-driven wakes.
 */
export interface QuietHint {
  sessionId: string;
  until: Date;
  reason: string | null;
}

export class QuietHintStore {
  private hints = new Map<string, QuietHint>();

  /**
   * Record a new "expect quiet for N seconds" hint. Overwrites any
   * existing hint for the same session — an agent that extends its
   * quiet window issues a fresh hint rather than stacking them.
   * A non-positive `seconds` clears the hint.
   */
  record(
    sessionId: string,
    seconds: number,
    reason: string | null,
    now: Date = new Date(),
  ): void {
    if (seconds <= 0) {
      this.hints.delete(sessionId);
      return;
    }
    this.hints.set(sessionId, {
      sessionId,
      until: new Date(now.getTime() + seconds * 1000),
      reason,
    });
  }

  /**
   * True if a hint is active for the session. Expired hints are
   * GC'd on access; no separate sweep needed.
   */
  isQuiet(sessionId: string, now: Date = new Date()): boolean {
    const hint = this.hints.get(sessionId);
    if (!hint) return false;
    if (hint.until.getTime() <= now.getTime()) {
      this.hints.delete(sessionId);
      return false;
    }
    return true;
  }

  /** For observability. */
  activeCount(): number {
    return this.hints.size;
  }
}
