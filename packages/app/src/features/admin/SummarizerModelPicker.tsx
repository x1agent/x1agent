import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import type { ModelRow } from "./AnthropicModelsPanel";

interface SummaryModelResponse {
  model_id: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Admin-selectable model used for session summaries. The Vertex /
 * api-key summarizer reads this on each call (no api restart needed).
 *
 * Source of truth for the dropdown is the enabled models from the
 * panel above — the parent passes them in via `enabledModels` so this
 * component doesn't re-fetch.
 */
export function SummarizerModelPicker({
  enabledModels,
}: {
  enabledModels: readonly ModelRow[];
}) {
  const [current, setCurrent] = useState<SummaryModelResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    try {
      const r = await apiFetch<SummaryModelResponse>(
        "/api/admin/anthropic/models/summary-model",
      );
      setCurrent(r);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };

  const save = async (modelId: string | null) => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await apiFetch<{ ok: boolean; model_id: string | null }>(
        "/api/admin/anthropic/models/summary-model",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id: modelId }),
        },
      );
      setCurrent({
        model_id: r.model_id,
        updated_at: new Date().toISOString(),
        updated_by: current?.updated_by ?? null,
      });
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const selected = current?.model_id ?? "";
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    void save(v === "" ? null : v);
  };

  // The current selection might not be in the enabled list (e.g. an
  // admin turned that model off after picking it). Show it anyway so
  // the operator sees what is *actually* set, but mark it disabled.
  const inEnabled = current?.model_id
    ? enabledModels.some((m) => m.id === current.model_id)
    : true;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Summarization model</CardTitle>
        <CardDescription>
          Used by the session summarizer. Pick one of the enabled
          models above. Falls back to the compiled-in default when
          unset. Changes take effect within a few seconds — no api
          restart needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadError && (
          <div className="mb-3 text-sm text-red-400">{loadError}</div>
        )}
        <div className="flex items-center gap-2">
          <select
            data-testid="summary-model-picker"
            disabled={saving}
            value={selected}
            onChange={onChange}
            className="min-w-0 flex-1 rounded-md border border-border-soft bg-canvas px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">— Use default —</option>
            {/* Stale selection (was enabled when picked, now disabled).
                Render it so the operator isn't confused by an empty
                dropdown that doesn't reflect the saved value. */}
            {current?.model_id && !inEnabled && (
              <option value={current.model_id} disabled>
                {current.model_id} (no longer enabled)
              </option>
            )}
            {enabledModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.id}
              </option>
            ))}
          </select>
          {saving && (
            <span className="text-xs text-fg-faint">Saving…</span>
          )}
          {!saving && savedAt && Date.now() - savedAt < 3000 && (
            <span className="text-xs text-emerald-300">Saved</span>
          )}
        </div>
        {saveError && (
          <div className="mt-2 text-sm text-red-400">{saveError}</div>
        )}
        {enabledModels.length === 0 && (
          <p className="mt-2 text-xs text-amber-300">
            No enabled models yet. Enable at least one above before
            picking a summarizer.
          </p>
        )}
        {current?.updated_at && current.updated_by && (
          <p className="mt-2 text-[11px] text-fg-faint">
            Last updated {new Date(current.updated_at).toLocaleString()} by{" "}
            {current.updated_by}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
