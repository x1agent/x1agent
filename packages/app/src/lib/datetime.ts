/**
 * Single render helper for every UTC timestamp the UI shows. Reads the
 * viewer's IANA timezone from `useAuthStore` and feeds it to
 * `Intl.DateTimeFormat`. Module-level so it works in both React
 * renderers and zustand store actions without hooking.
 *
 * The browser is the authority on whose tz this is — the user picked
 * it (or accepted the browser-detected default) on /account. NULL
 * timezone on the user falls back to UTC formatting, which is at
 * least honest about what the underlying value is.
 *
 * Also exposes `userIanaTz()` so the ScheduleBuilder (which does
 * local↔UTC cron conversion itself) can read the same value without
 * duplicating the lookup.
 */
import { useAuthStore } from "../stores/authStore";

export function userIanaTz(): string {
  return useAuthStore.getState().user?.timezone ?? "UTC";
}

/**
 * Format an ISO-8601 string or Date as a human-readable timestamp in
 * the viewer's timezone. The default produces "May 17, 2026, 3:42 PM";
 * pass any `Intl.DateTimeFormatOptions` to customise.
 */
export function formatInUserTz(
  value: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
): string {
  if (value == null) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: userIanaTz(),
    ...opts,
  }).format(d);
}

/**
 * Compact date-only format ("May 17, 2026") in the viewer's timezone.
 * Used in list rows where time-of-day clutters the column.
 */
export function formatDateInUserTz(value: string | Date | null | undefined): string {
  return formatInUserTz(value, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Compact time-only format ("3:42 PM") in the viewer's timezone.
 * Pair with `formatDateInUserTz` for two-line "May 17 · 3:42 PM"
 * layouts where the column gives the date its own line.
 */
export function formatTimeInUserTz(value: string | Date | null | undefined): string {
  return formatInUserTz(value, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Convert a "local hour, local minute" pair in the viewer's tz to the
 * equivalent UTC (hour, minute) pair. Used by the ScheduleBuilder to
 * translate a user-entered time into the cron expression we ship to
 * the API.
 *
 * Notes:
 *   - Uses a reference date of "today" — DST is sampled at that point,
 *     not at every potential fire time. The DST drift trade-off lives
 *     here; if the user crosses a DST boundary after saving, the
 *     scheduler still fires at the originally-converted UTC time. The
 *     UI rounds back to the same local hour because both directions
 *     consult the SAME `today` reference, but the underlying cron
 *     means a different local time in the other DST half. See the
 *     comment on the matching utcCronToLocal() for the read side.
 *   - Returns 0–23 hour and 0–59 minute integers. The cron string the
 *     caller builds carries those as-is.
 */
export function localTimeToUtc(
  localHour: number,
  localMinute: number,
): { hour: number; minute: number } {
  const tz = userIanaTz();
  const today = new Date();
  today.setSeconds(0, 0);

  // Anchor a Date at the chosen local time IN the user's tz, then read
  // back what UTC clock that landed on. Intl gives us each part in the
  // target tz; we walk the offset by constructing a Date that, when
  // expressed in `tz`, has the requested hour/minute on today's date.
  const probe = new Date(today.getTime());
  // Iteratively close the gap — Date doesn't expose a "construct in
  // tz" primitive, so we anchor against ourselves: take an arbitrary
  // moment, see what hour Intl renders in `tz`, then offset the UTC
  // time by the delta. One pass is enough for fixed-offset zones; two
  // covers the rare DST-transition spillover.
  for (let pass = 0; pass < 2; pass++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(probe);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const dh = ((localHour - h) + 24) % 24;
    const dm = localMinute - m;
    probe.setTime(probe.getTime() + (dh * 60 + dm) * 60_000);
  }
  return { hour: probe.getUTCHours(), minute: probe.getUTCMinutes() };
}

/**
 * Inverse of `localTimeToUtc`. Given a (utcHour, utcMinute) pair as
 * stored in a cron expression, return what hour/minute that represents
 * in the viewer's timezone — used by ScheduleBuilder to show the
 * stored cron expression in the user's local clock.
 */
export function utcCronToLocal(
  utcHour: number,
  utcMinute: number,
): { hour: number; minute: number } {
  const tz = userIanaTz();
  const probe = new Date();
  probe.setUTCHours(utcHour, utcMinute, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(probe);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Intl's hour can come back as "24" at midnight under some
  // locales — normalize to 0.
  return { hour: h === 24 ? 0 : h, minute: m };
}

/**
 * Short human label for the viewer's tz (e.g. "EDT", "PST"). Falls
 * back to the raw IANA name when the runtime can't shorten it.
 */
export function shortTzLabel(date: Date = new Date()): string {
  const tz = userIanaTz();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(date);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    return name ?? tz;
  } catch {
    return tz;
  }
}
