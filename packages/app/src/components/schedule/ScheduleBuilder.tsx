import { useMemo } from "react";
import cronstrue from "cronstrue";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

/**
 * Frequency-first schedule builder. Reusable wherever the app needs
 * to collect a cron-style schedule — agents today, future hooks and
 * jobs tomorrow.
 *
 * API:
 *   <ScheduleBuilder value={cronString} onChange={setCronString} />
 *
 * Value shape matches the CronSchedule validator in
 * `@x1agent/domain-agents`:
 *   - ""            → manual only
 *   - "@hourly", "@daily", "@weekly", "@monthly", "@yearly"
 *   - "@every <n>(m|h|d)"
 *   - 5-field cron ("M H D M W")
 *
 * Under the hood: the component keeps a structured frequency state,
 * composes it into a cron string on every change, and parses an
 * incoming cron string back into structured state on mount so
 * existing schedules round-trip losslessly. Anything the parser
 * doesn't recognize drops into Custom with the raw cron preserved —
 * so the component degrades gracefully rather than silently rewriting
 * the user's handcrafted cron.
 */

type StructuredSchedule =
  | { kind: "manual" }
  | { kind: "minutes"; interval: number }
  | { kind: "hours"; interval: number }
  | { kind: "daily"; hour: number; minute: number }
  | {
      kind: "weekly";
      hour: number;
      minute: number;
      /** Sunday = 0, Monday = 1, ..., Saturday = 6. */
      days: ReadonlySet<number>;
    }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "custom"; raw: string };

const FREQUENCY_OPTIONS: {
  id: StructuredSchedule["kind"];
  label: string;
}[] = [
  { id: "manual", label: "Manual only" },
  { id: "minutes", label: "Every N minutes" },
  { id: "hours", label: "Every N hours" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "On days of week" },
  { id: "monthly", label: "Monthly" },
  { id: "custom", label: "Custom cron" },
];

const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const DOW_TITLES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const DOW_NAME_TO_NUM: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

// ── Parsing ──────────────────────────────────────────────────────
//
// Best-effort parser: turns a stored cron string into structured
// state so the UI can show the right sub-controls. Anything beyond
// what we recognize drops into Custom with the raw value preserved.

function parseCron(value: string): StructuredSchedule {
  const raw = value.trim();
  if (!raw) return { kind: "manual" };

  const lower = raw.toLowerCase();

  // Named macros map onto the closest structured equivalent. We
  // rewrite rather than carry them as-is so the UI's controls stay
  // populated (an @hourly agent should show "Every hour", not an
  // inscrutable Custom field).
  if (lower === "@hourly") return { kind: "hours", interval: 1 };
  if (lower === "@daily" || lower === "@midnight")
    return { kind: "daily", hour: 0, minute: 0 };

  const every = lower.match(/^@every\s+(\d+)\s*(m|h|d)$/);
  if (every) {
    const n = Number(every[1]);
    if (every[2] === "m") return { kind: "minutes", interval: n };
    if (every[2] === "h") return { kind: "hours", interval: n };
    // @every Nd translates to daily at midnight every N days — not
    // representable in 5-field cron without DST hazards, so we keep
    // it as Custom rather than lie to the user.
  }

  const parts = raw.split(/\s+/);
  if (parts.length === 5) {
    const [minF, hourF, domF, monF, dowF] = parts;
    const minute = parseSingleInt(minF);
    const hour = parseSingleInt(hourF);
    if (minute !== null && hour !== null && monF === "*") {
      // Daily: day-of-month and day-of-week both wildcards.
      if (domF === "*" && dowF === "*") {
        return { kind: "daily", hour, minute };
      }
      // Weekly: dom wildcard, dow specifies one or more days.
      if (domF === "*" && dowF !== "*") {
        const days = parseDowField(dowF);
        if (days) return { kind: "weekly", hour, minute, days };
      }
      // Monthly: dom is a specific day-of-month, dow wildcard.
      if (dowF === "*" && domF !== "*") {
        const day = parseSingleInt(domF);
        if (day !== null) return { kind: "monthly", day, hour, minute };
      }
    }
  }

  return { kind: "custom", raw };
}

function parseSingleInt(field: string): number | null {
  if (!/^\d+$/.test(field)) return null;
  return Number(field);
}

function parseDowField(field: string): ReadonlySet<number> | null {
  const out = new Set<number>();
  for (const part of field.toLowerCase().split(",")) {
    const range = part.match(/^([a-z0-9]+)-([a-z0-9]+)$/);
    if (range) {
      const a = dowToNum(range[1]);
      const b = dowToNum(range[2]);
      if (a === null || b === null) return null;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) out.add(i);
      continue;
    }
    const n = dowToNum(part);
    if (n === null) return null;
    out.add(n);
  }
  return out.size > 0 ? out : null;
}

function dowToNum(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    // cron allows 0 or 7 for Sunday; normalize both to 0.
    if (n === 7) return 0;
    if (n >= 0 && n <= 6) return n;
    return null;
  }
  const mapped = DOW_NAME_TO_NUM[token];
  return mapped === undefined ? null : mapped;
}

// ── Serialization ────────────────────────────────────────────────

function toCron(s: StructuredSchedule): string {
  switch (s.kind) {
    case "manual":
      return "";
    case "minutes":
      return `@every ${clampInt(s.interval, 1, 59)}m`;
    case "hours":
      return `@every ${clampInt(s.interval, 1, 23)}h`;
    case "daily":
      return `${clampInt(s.minute, 0, 59)} ${clampInt(s.hour, 0, 23)} * * *`;
    case "weekly": {
      const days = [...s.days].sort((a, b) => a - b);
      const dow = days.length === 0 ? "*" : days.join(",");
      return `${clampInt(s.minute, 0, 59)} ${clampInt(s.hour, 0, 23)} * * ${dow}`;
    }
    case "monthly":
      return `${clampInt(s.minute, 0, 59)} ${clampInt(s.hour, 0, 23)} ${clampInt(
        s.day,
        1,
        31,
      )} * *`;
    case "custom":
      return s.raw;
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

// ── Live human-readable preview ──────────────────────────────────

function describe(cron: string): string | null {
  const raw = cron.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const every = lower.match(/^@every\s+(\d+)\s*(m|h|d)$/);
  if (every) {
    const n = Number(every[1]);
    const unit =
      every[2] === "m"
        ? n === 1
          ? "minute"
          : "minutes"
        : every[2] === "h"
          ? n === 1
            ? "hour"
            : "hours"
          : n === 1
            ? "day"
            : "days";
    return `Every ${n} ${unit}`;
  }
  const macros: Record<string, string> = {
    "@hourly": "At the top of every hour",
    "@daily": "At 00:00 every day",
    "@midnight": "At 00:00 every day",
    "@weekly": "At 00:00 every Sunday",
    "@monthly": "At 00:00 on the 1st of every month",
    "@yearly": "At 00:00 on January 1st",
    "@annually": "At 00:00 on January 1st",
  };
  if (macros[lower]) return macros[lower];
  try {
    return cronstrue.toString(raw, { use24HourTimeFormat: true });
  } catch {
    return null;
  }
}

// ── Component ────────────────────────────────────────────────────

export interface ScheduleBuilderProps {
  value: string;
  onChange: (next: string) => void;
}

export function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
  const state = useMemo(() => parseCron(value), [value]);
  const preview = useMemo(() => describe(value), [value]);

  const setKind = (kind: StructuredSchedule["kind"]) => {
    onChange(toCron(defaultFor(kind, state)));
  };
  const patch = (next: StructuredSchedule) => onChange(toCron(next));

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Frequency</Label>
        <Select
          value={state.kind}
          onValueChange={(v) => setKind(v as StructuredSchedule["kind"])}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FREQUENCY_OPTIONS.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {state.kind === "minutes" && (
        <IntervalRow
          label="Run every"
          unit={state.interval === 1 ? "minute" : "minutes"}
          value={state.interval}
          min={1}
          max={59}
          onChange={(interval) => patch({ ...state, interval })}
        />
      )}

      {state.kind === "hours" && (
        <IntervalRow
          label="Run every"
          unit={state.interval === 1 ? "hour" : "hours"}
          value={state.interval}
          min={1}
          max={23}
          onChange={(interval) => patch({ ...state, interval })}
        />
      )}

      {state.kind === "daily" && (
        <TimeRow
          label="Run at"
          hour={state.hour}
          minute={state.minute}
          onChange={(hour, minute) => patch({ ...state, hour, minute })}
        />
      )}

      {state.kind === "weekly" && (
        <>
          <TimeRow
            label="Run at"
            hour={state.hour}
            minute={state.minute}
            onChange={(hour, minute) => patch({ ...state, hour, minute })}
          />
          <DayPicker
            days={state.days}
            onToggle={(day) => {
              const next = new Set(state.days);
              if (next.has(day)) next.delete(day);
              else next.add(day);
              patch({ ...state, days: next });
            }}
          />
        </>
      )}

      {state.kind === "monthly" && (
        <>
          <div className="space-y-1.5">
            <Label>Day of month</Label>
            <Input
              type="number"
              min={1}
              max={31}
              value={state.day}
              onChange={(e) =>
                patch({ ...state, day: Number(e.target.value) || 1 })
              }
              className="w-24"
            />
          </div>
          <TimeRow
            label="At"
            hour={state.hour}
            minute={state.minute}
            onChange={(hour, minute) => patch({ ...state, hour, minute })}
          />
        </>
      )}

      {state.kind === "custom" && (
        <div className="space-y-1.5">
          <Label>Cron expression</Label>
          <Input
            value={state.raw}
            onChange={(e) => patch({ kind: "custom", raw: e.target.value })}
            placeholder="0 9 * * mon-fri"
            className="font-mono text-xs"
          />
        </div>
      )}

      {state.kind !== "manual" && (
        <p
          className={`text-xs ${preview ? "text-zinc-500" : "text-amber-400"}`}
        >
          {preview ??
            "Unrecognized cron — the server may still accept it if the syntax is valid."}
        </p>
      )}
    </div>
  );
}

// ── Sub-controls ─────────────────────────────────────────────────

function IntervalRow({
  label,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-300">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || min)}
        className="w-20"
      />
      <span>{unit}</span>
    </div>
  );
}

function TimeRow({
  label,
  hour,
  minute,
  onChange,
}: {
  label: string;
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
}) {
  const formatted = `${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0",
  )}`;
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-300">
      <span>{label}</span>
      <Input
        type="time"
        value={formatted}
        onChange={(e) => {
          const [h, m] = e.target.value.split(":");
          onChange(Number(h) || 0, Number(m) || 0);
        }}
        className="w-32"
      />
    </div>
  );
}

function DayPicker({
  days,
  onToggle,
}: {
  days: ReadonlySet<number>;
  onToggle: (day: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>On</Label>
      <div className="flex gap-1">
        {DOW_LABELS.map((label, day) => {
          const active = days.has(day);
          return (
            <button
              key={`${day}-${DOW_TITLES[day]}`}
              type="button"
              title={DOW_TITLES[day]}
              onClick={() => onToggle(day)}
              className={
                active
                  ? "size-9 rounded-md border border-zinc-200 bg-zinc-100 text-sm font-medium text-zinc-900 transition-colors"
                  : "size-9 rounded-md border border-zinc-800 bg-zinc-950 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
              }
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Kind transition defaults ─────────────────────────────────────
//
// Switching between kinds should keep as much context as possible —
// time values carry across daily/weekly/monthly so the user doesn't
// have to re-pick 09:00 every time. Unknown transitions fall back to
// sensible seeds.

function defaultFor(
  kind: StructuredSchedule["kind"],
  prev: StructuredSchedule,
): StructuredSchedule {
  const prevHour =
    prev.kind === "daily" ||
    prev.kind === "weekly" ||
    prev.kind === "monthly"
      ? prev.hour
      : 9;
  const prevMinute =
    prev.kind === "daily" ||
    prev.kind === "weekly" ||
    prev.kind === "monthly"
      ? prev.minute
      : 0;

  switch (kind) {
    case "manual":
      return { kind: "manual" };
    case "minutes":
      return {
        kind: "minutes",
        interval: prev.kind === "minutes" ? prev.interval : 15,
      };
    case "hours":
      return {
        kind: "hours",
        interval: prev.kind === "hours" ? prev.interval : 1,
      };
    case "daily":
      return { kind: "daily", hour: prevHour, minute: prevMinute };
    case "weekly":
      return {
        kind: "weekly",
        hour: prevHour,
        minute: prevMinute,
        days:
          prev.kind === "weekly" && prev.days.size > 0
            ? prev.days
            : new Set([1, 2, 3, 4, 5]),
      };
    case "monthly":
      return {
        kind: "monthly",
        day: prev.kind === "monthly" ? prev.day : 1,
        hour: prevHour,
        minute: prevMinute,
      };
    case "custom":
      // Seed from the current cron (if any) so switching in and out
      // of custom doesn't clobber the user's text.
      return {
        kind: "custom",
        raw: prev.kind === "custom" ? prev.raw : toCron(prev) || "0 * * * *",
      };
  }
}
