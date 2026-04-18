import { ValidationError } from "@x1agent/kernel";

declare const cronBrand: unique symbol;
export type CronSchedule = string & { readonly [cronBrand]: true };

/**
 * Named macros supported in addition to 5-field cron. `@every <n>m|h|d`
 * is a local convenience for "every N minutes/hours/days"; the scheduler
 * resolves it at tick time.
 */
const MACROS = new Set([
  "@hourly",
  "@daily",
  "@weekly",
  "@monthly",
  "@yearly",
  "@annually",
]);
const EVERY_RE = /^@every\s+\d+\s*(m|h|d)$/;
// Shape-only check: digits, stars, day/month name letters, range/list/step
// operators. The scheduler parses deeply; we just reject obvious garbage.
const FIELD_RE = /^[a-z0-9*\-,/]+$/i;

export function CronSchedule(raw: string): CronSchedule {
  const trimmed = raw.trim();
  if (!trimmed) throw new ValidationError("schedule", "cannot be empty");
  if (MACROS.has(trimmed.toLowerCase())) return trimmed as CronSchedule;
  if (EVERY_RE.test(trimmed.toLowerCase())) return trimmed as CronSchedule;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new ValidationError(
      "schedule",
      "must be a 5-field cron, a named macro (@hourly, @daily, ...), or @every <n>(m|h|d)",
    );
  }
  for (const p of parts) {
    if (!FIELD_RE.test(p)) {
      throw new ValidationError(
        "schedule",
        `invalid cron field: ${p}`,
      );
    }
  }
  return trimmed as CronSchedule;
}
