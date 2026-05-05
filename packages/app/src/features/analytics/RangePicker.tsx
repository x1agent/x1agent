import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Checkbox } from "../../components/ui/checkbox";
import { PRESETS, type RangePreset } from "./range";
import { useAnalyticsStore } from "../../stores/analyticsStore";

interface Props {
  workspaceSlug: string;
}

/**
 * Preset toggle row + custom date inputs that appear when "Custom"
 * is selected. State lives in the analytics store; this component is
 * a thin reactive view.
 */
export function RangePicker({ workspaceSlug }: Props) {
  const ws = useAnalyticsStore(
    (s) =>
      s.byWorkspace[workspaceSlug] ?? {
        preset: "thisMonth" as RangePreset,
        customSince: null,
        customUntil: null,
        data: null,
        loading: false,
        error: null,
      },
  );
  const setPreset = useAnalyticsStore((s) => s.setPreset);
  const setCustomRange = useAnalyticsStore((s) => s.setCustomRange);
  const setCompareEnabled = useAnalyticsStore((s) => s.setCompareEnabled);
  const compareEnabled = useAnalyticsStore(
    (s) => s.byWorkspace[workspaceSlug]?.compareEnabled ?? false,
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border-soft bg-bg p-1">
          {PRESETS.map((p) => (
            <Button
              key={p.value}
              type="button"
              size="sm"
              variant={ws.preset === p.value ? "secondary" : "ghost"}
              onClick={() => setPreset(workspaceSlug, p.value)}
              className="h-7 px-2 text-xs"
            >
              {p.label}
            </Button>
          ))}
        </div>
        <label className="flex h-8 cursor-pointer select-none items-center gap-2 rounded-md border border-border-soft bg-bg px-3 text-xs text-fg-muted">
          <Checkbox
            checked={compareEnabled}
            onCheckedChange={(v) => setCompareEnabled(workspaceSlug, v === true)}
            aria-label="Compare to prior period"
          />
          Compare prior period
        </label>
      </div>
      {ws.preset === "custom" && (
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border-soft bg-bg px-3 py-2">
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`analytics-since-${workspaceSlug}`}
              className="text-xs text-fg-muted"
            >
              From
            </Label>
            <Input
              id={`analytics-since-${workspaceSlug}`}
              type="date"
              value={ws.customSince ?? ""}
              onChange={(e) =>
                setCustomRange(
                  workspaceSlug,
                  e.target.value || null,
                  ws.customUntil,
                )
              }
              className="h-8 w-40 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`analytics-until-${workspaceSlug}`}
              className="text-xs text-fg-muted"
            >
              To (exclusive)
            </Label>
            <Input
              id={`analytics-until-${workspaceSlug}`}
              type="date"
              value={ws.customUntil ?? ""}
              onChange={(e) =>
                setCustomRange(
                  workspaceSlug,
                  ws.customSince,
                  e.target.value || null,
                )
              }
              className="h-8 w-40 text-xs"
            />
          </div>
        </div>
      )}
    </div>
  );
}
