/**
 * Time-range presets for the Analytics tab.
 *
 * The api accepts `since` (inclusive) + `until` (exclusive) as
 * YYYY-MM-DD strings, parsed at UTC midnight. Each preset maps to a
 * range whose `until` is one tick past the visible end so a "this
 * month" preset asked at 23:59 on the 30th still includes that
 * day's spend. Pure — no Date.now() / new Date() inside production
 * paths; the wrapper functions take an explicit `now` for testability.
 */

export type RangePreset =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "thisMonth"
  | "last30d"
  | "last90d"
  | "custom";

export interface DateRange {
  /** YYYY-MM-DD inclusive. */
  since: string;
  /** YYYY-MM-DD exclusive. */
  until: string;
}

const fmt = (d: Date): string => {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const startOfUTCDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const addDays = (d: Date, n: number): Date => {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
};

/**
 * "This week" anchors to Monday — the work week most operators think
 * in. Sunday weeks are equally valid; pick one and stick with it.
 */
const startOfUTCWeekMonday = (d: Date): Date => {
  const start = startOfUTCDay(d);
  const day = start.getUTCDay(); // 0 Sun .. 6 Sat
  const offset = day === 0 ? 6 : day - 1;
  return addDays(start, -offset);
};

const startOfUTCMonth = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/**
 * Resolve a preset to a concrete date range against the supplied
 * "now" instant. `custom` falls back to `thisMonth` when the caller
 * doesn't supply a custom range — the picker UI ensures both fields
 * are set before flipping to the custom preset, but defending here
 * means a stale URL or hand-crafted state doesn't render an empty
 * dashboard.
 */
export function presetToRange(
  preset: RangePreset,
  now: Date,
  custom?: { since: string | null; until: string | null },
): DateRange {
  const today = startOfUTCDay(now);
  switch (preset) {
    case "today":
      return { since: fmt(today), until: fmt(addDays(today, 1)) };
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return { since: fmt(yesterday), until: fmt(today) };
    }
    case "thisWeek":
      return {
        since: fmt(startOfUTCWeekMonday(today)),
        until: fmt(addDays(today, 1)),
      };
    case "thisMonth":
      return {
        since: fmt(startOfUTCMonth(today)),
        until: fmt(addDays(today, 1)),
      };
    case "last30d":
      return { since: fmt(addDays(today, -29)), until: fmt(addDays(today, 1)) };
    case "last90d":
      return { since: fmt(addDays(today, -89)), until: fmt(addDays(today, 1)) };
    case "custom":
      if (custom?.since && custom?.until) {
        return { since: custom.since, until: custom.until };
      }
      // Bad state — degrade to thisMonth rather than rendering empty.
      return presetToRange("thisMonth", now);
  }
}

/**
 * Compute the matching prior range for "compare to previous period"
 * overlays. Each preset gets the natural-language equivalent:
 *   today      → yesterday
 *   yesterday  → day before yesterday
 *   thisWeek   → last week (Mon–Sun preceding "this week's" Monday)
 *   thisMonth  → previous full month
 *   last30d    → 30 days before that window (-60..-30)
 *   last90d    → 90 days before that window (-180..-90)
 *   custom     → equal-length window immediately before [since, until)
 */
export function priorRange(
  preset: RangePreset,
  now: Date,
  custom?: { since: string | null; until: string | null },
): DateRange {
  const today = startOfUTCDay(now);
  switch (preset) {
    case "today": {
      const yesterday = addDays(today, -1);
      return { since: fmt(yesterday), until: fmt(today) };
    }
    case "yesterday": {
      const dayBefore = addDays(today, -2);
      return { since: fmt(dayBefore), until: fmt(addDays(today, -1)) };
    }
    case "thisWeek": {
      const weekStart = startOfUTCWeekMonday(today);
      const priorWeekStart = addDays(weekStart, -7);
      return { since: fmt(priorWeekStart), until: fmt(weekStart) };
    }
    case "thisMonth": {
      const thisMonthStart = startOfUTCMonth(today);
      const priorMonthStart = new Date(
        Date.UTC(
          thisMonthStart.getUTCFullYear(),
          thisMonthStart.getUTCMonth() - 1,
          1,
        ),
      );
      return { since: fmt(priorMonthStart), until: fmt(thisMonthStart) };
    }
    case "last30d":
      return { since: fmt(addDays(today, -59)), until: fmt(addDays(today, -29)) };
    case "last90d":
      return {
        since: fmt(addDays(today, -179)),
        until: fmt(addDays(today, -89)),
      };
    case "custom": {
      const cur = presetToRange("custom", now, custom);
      const sinceDate = parseDay(cur.since);
      const untilDate = parseDay(cur.until);
      if (!sinceDate || !untilDate) return cur;
      const ms = untilDate.getTime() - sinceDate.getTime();
      const priorUntil = sinceDate;
      const priorSince = new Date(sinceDate.getTime() - ms);
      return { since: fmt(priorSince), until: fmt(priorUntil) };
    }
  }
}

function parseDay(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export const PRESETS: { value: RangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisWeek", label: "This week" },
  { value: "thisMonth", label: "This month" },
  { value: "last30d", label: "Last 30 days" },
  { value: "last90d", label: "Last 90 days" },
  { value: "custom", label: "Custom" },
];

export const DEFAULT_PRESET: RangePreset = "thisMonth";
