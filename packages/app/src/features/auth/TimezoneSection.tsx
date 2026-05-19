import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { apiFetch } from "../../lib/api";
import { useAuthStore } from "../../stores/authStore";

/**
 * /account page — IANA timezone picker.
 *
 * Drives every UTC-timestamp render in the app via the shared
 * `formatInUserTz()` helper, plus the ScheduleBuilder's local↔UTC
 * cron conversion. The browser's detected zone is offered as the
 * default; the user can override.
 *
 * Storage: PUT /api/me/timezone. After save, refetches `/auth/me` so
 * authStore picks up the new value and every renderer downstream
 * sees the change without a page reload.
 */
export function TimezoneSection() {
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const userTz = useAuthStore((s) => s.user?.timezone ?? null);

  const detected = useMemo<string>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const zones = useMemo<string[]>(() => {
    type IntlExtended = typeof Intl & {
      supportedValuesOf?: (key: string) => string[];
    };
    const ext = Intl as IntlExtended;
    if (typeof ext.supportedValuesOf === "function") {
      return ext.supportedValuesOf("timeZone");
    }
    // Old runtimes — at least surface the detected zone so the picker
    // has one valid choice. Falls back to UTC otherwise.
    return [detected, "UTC"].filter((v, i, a) => a.indexOf(v) === i);
  }, [detected]);

  const [selected, setSelected] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setSelected(userTz ?? detected);
  }, [userTz, detected]);

  const isDirty = selected !== (userTz ?? detected) || userTz === null;

  const onSave = async () => {
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      await apiFetch("/api/me/timezone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: selected }),
      });
      await fetchMe();
      setSavedNotice(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onClear = async () => {
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      await apiFetch("/api/me/timezone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: null }),
      });
      await fetchMe();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timezone</CardTitle>
        <CardDescription>
          Used to localize every date in the app — session timestamps,
          cost rollups, share created-at, and the schedule picker on
          agent pages. Stored crons stay UTC; conversion happens at
          render time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="tz-picker">IANA timezone</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id="tz-picker" className="w-[320px]">
              <SelectValue placeholder="Choose a timezone…" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {zones.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-fg-faint">
            Browser detected:{" "}
            <code className="text-fg-muted">{detected}</code>
            {userTz === null && (
              <>
                {" "}
                · currently unset, falling back to{" "}
                <code className="text-fg-muted">UTC</code>
              </>
            )}
          </p>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {savedNotice && !error && (
          <p className="text-xs text-green-400">
            Saved. Every date in the app now renders in {selected}.
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || !selected || !isDirty}
          >
            {saving ? "Saving…" : userTz === null ? "Save" : "Update"}
          </Button>
          {userTz !== null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClear}
              disabled={saving}
            >
              Reset (use UTC)
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
