import parser from "cron-parser";
import type { CronSchedule } from "@x1agent/domain-agents";

const EVERY_RE = /^@every\s+(\d+)\s*(m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Given a cron-or-macro schedule and a previous fire time, return the next
 * fire time strictly after `after`. Supports standard cron, @hourly/@daily
 * macros (via cron-parser), and our local `@every <n>(m|h|d)`.
 */
export function nextDueAfter(schedule: CronSchedule, after: Date): Date {
  const trimmed = schedule.trim();
  const m = EVERY_RE.exec(trimmed);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const ms = UNIT_MS[unit]! * n;
    return new Date(after.getTime() + ms);
  }

  const interval = parser.parseExpression(trimmed, {
    currentDate: after,
  });
  return interval.next().toDate();
}
