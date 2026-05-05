import * as Sentry from "@sentry/node";

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  jitterMs?: number;
  runOnStart?: boolean;
  fn: () => Promise<void>;
}

export interface PeriodicScheduler {
  register(task: ScheduledTask): void;
  start(): void;
  stop(): Promise<void>;
}

interface InternalTask extends ScheduledTask {
  ticking: boolean;
  handle: ReturnType<typeof setTimeout> | null;
}

export interface SchedulerOptions {
  logger?: (line: string) => void;
  /** Bounded wait for in-flight ticks during stop(). */
  shutdownTimeoutMs?: number;
}

export function createPeriodicScheduler(
  opts: SchedulerOptions = {},
): PeriodicScheduler {
  const log = opts.logger ?? ((s) => console.log(s));
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 30_000;
  const tasks: InternalTask[] = [];
  let started = false;

  const runOnce = async (t: InternalTask) => {
    // Overlap guard. If a tick takes longer than its interval, we drop
    // the next firing rather than running concurrently. Same semantics
    // as the hand-rolled `if (ticking) return` boilerplate it replaces.
    if (t.ticking) {
      log(`[scheduler] task=${t.name} skipped reason=overlap`);
      return;
    }
    t.ticking = true;
    const start = Date.now();
    try {
      await t.fn();
      const took = Date.now() - start;
      // Quiet by default: only log slow ticks. The ticks that wanted
      // visibility into their own work already log it themselves.
      if (took > t.intervalMs) {
        log(
          `[scheduler] task=${t.name} took=${took}ms ok (longer than interval=${t.intervalMs}ms)`,
        );
      }
    } catch (err) {
      const took = Date.now() - start;
      log(
        `[scheduler] task=${t.name} took=${took}ms err=${(err as Error).message}`,
      );
      Sentry.captureException(err, { tags: { scheduler_task: t.name } });
    } finally {
      t.ticking = false;
    }
  };

  const jitterFor = (t: InternalTask): number => {
    if (!t.jitterMs || t.jitterMs <= 0) return 0;
    return Math.floor(Math.random() * t.jitterMs * 2) - t.jitterMs;
  };

  const scheduleNext = (t: InternalTask) => {
    const delay = Math.max(0, t.intervalMs + jitterFor(t));
    t.handle = setTimeout(async () => {
      if (!started) return;
      await runOnce(t);
      if (started) scheduleNext(t);
    }, delay);
    const h = t.handle as unknown as { unref?: () => void };
    if (typeof h.unref === "function") h.unref();
  };

  return {
    register(task) {
      if (started) {
        throw new Error(
          `[scheduler] register("${task.name}") called after start(); register all tasks before start()`,
        );
      }
      if (tasks.some((t) => t.name === task.name)) {
        throw new Error(`[scheduler] duplicate task name: ${task.name}`);
      }
      tasks.push({ ...task, ticking: false, handle: null });
    },
    start() {
      if (started) return;
      started = true;
      log(`[scheduler] starting ${tasks.length} task(s)`);
      for (const t of tasks) {
        if (t.runOnStart) {
          // Fire-and-forget initial kick so start() returns quickly.
          // The first scheduled tick still happens after intervalMs.
          void runOnce(t);
        }
        scheduleNext(t);
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      for (const t of tasks) {
        if (t.handle) clearTimeout(t.handle);
        t.handle = null;
      }
      // Wait for any in-flight tick to drain. Bounded — a stuck tick
      // shouldn't block shutdown forever.
      const deadline = Date.now() + shutdownTimeoutMs;
      while (tasks.some((t) => t.ticking) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const stuck = tasks.filter((t) => t.ticking).map((t) => t.name);
      if (stuck.length > 0) {
        log(
          `[scheduler] stop: ${stuck.length} task(s) still in-flight after ${shutdownTimeoutMs}ms: ${stuck.join(",")}`,
        );
      }
    },
  };
}
