import { useMemo } from "react";
import cronstrue from "cronstrue";
import { Input } from "../../components/ui/input";

/**
 * Cadence picker for agents. Hides raw cron behind a row of preset
 * chips and only surfaces the text field when "Custom" is active.
 *
 * Value shape matches the domain's CronSchedule validator:
 *   - "" / null → manual only (not stored as a cron)
 *   - one of "@hourly", "@daily", "@weekly", "@monthly", "@yearly"
 *   - "@every <n>(m|h|d)"
 *   - a 5-field cron (e.g. "0 9 * * mon-fri")
 *
 * The human-readable preview runs cronstrue on 5-field crons and a
 * small local map for the macros cronstrue doesn't know about.
 */

interface Preset {
  id: string;
  label: string;
  /** Cron value this preset maps to. Empty string = "Manual only". */
  value: string;
}

const PRESETS: Preset[] = [
  { id: "manual", label: "Manual only", value: "" },
  { id: "15min", label: "Every 15 min", value: "@every 15m" },
  { id: "hourly", label: "Every hour", value: "@hourly" },
  { id: "daily-9am", label: "Daily 9am", value: "0 9 * * *" },
  { id: "weekdays-9am", label: "Weekdays 9am", value: "0 9 * * mon-fri" },
];

const CUSTOM_ID = "custom";

const MACRO_DESCRIPTIONS: Record<string, string> = {
  "@hourly": "At the top of every hour",
  "@daily": "At 00:00 every day",
  "@midnight": "At 00:00 every day",
  "@weekly": "At 00:00 every Sunday",
  "@monthly": "At 00:00 on the 1st of every month",
  "@yearly": "At 00:00 on January 1st",
  "@annually": "At 00:00 on January 1st",
};

function describe(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (MACRO_DESCRIPTIONS[lower]) return MACRO_DESCRIPTIONS[lower];
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
  try {
    return cronstrue.toString(v, { use24HourTimeFormat: true });
  } catch {
    return null;
  }
}

function presetForValue(value: string): string {
  const match = PRESETS.find((p) => p.value === value.trim());
  return match?.id ?? CUSTOM_ID;
}

export interface ScheduleFieldProps {
  value: string;
  onChange: (next: string) => void;
}

export function ScheduleField({ value, onChange }: ScheduleFieldProps) {
  const activeId = presetForValue(value);
  const showCustom = activeId === CUSTOM_ID;
  const preview = useMemo(() => describe(value), [value]);
  const valid =
    !value.trim() ||
    preview !== null ||
    // cronstrue returns null for some edge cases we still allow; this
    // belt-and-braces check keeps the warning from crying wolf when
    // the backend would happily accept the value.
    /^@every\s+\d+\s*(m|h|d)$/i.test(value.trim());

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.value)}
            className={chipClass(activeId === p.id)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            // Entering custom mode from a preset leaves the value
            // intact so the user can tweak the nearest known cron.
            // Entering from "Manual only" (empty) seeds a reasonable
            // starting point.
            if (!value.trim()) onChange("0 * * * *");
          }}
          className={chipClass(activeId === CUSTOM_ID)}
        >
          Custom
        </button>
      </div>

      {showCustom && (
        <div className="space-y-1.5">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0 9 * * mon-fri"
            className="font-mono text-xs"
          />
          <p
            className={`text-xs ${
              !value.trim()
                ? "text-zinc-600"
                : valid
                  ? "text-zinc-400"
                  : "text-amber-400"
            }`}
          >
            {!value.trim()
              ? "Enter a 5-field cron, a macro (@hourly, @daily…), or @every 15m."
              : preview
                ? preview
                : "Unrecognized cron expression — the server may still accept it."}
          </p>
        </div>
      )}

      {!showCustom && value.trim() && preview && (
        <p className="text-xs text-zinc-500">{preview}</p>
      )}
    </div>
  );
}

function chipClass(active: boolean): string {
  const base =
    "rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600";
  return active
    ? `${base} border-zinc-200 bg-zinc-100 text-zinc-900`
    : `${base} border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100`;
}
