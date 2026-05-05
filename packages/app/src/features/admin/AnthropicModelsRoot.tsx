import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useAuthStore } from "../../stores/authStore";

interface ModelRow {
  id: string;
  label: string;
  source: "vertex" | "api_key";
  enabled: boolean;
  last_probe_status: ProbeStatus | null;
  last_probe_error: string | null;
  last_probed_at: string | null;
  // Price columns: each `*_saved` is the operator's pinned override
  // (null = "use default"). Each `*_default` is the tier-classifier
  // best guess used when `_saved` is null.
  input_usd_per_million_saved: number | null;
  output_usd_per_million_saved: number | null;
  cache_read_multiplier_saved: number | null;
  cache_write_multiplier_saved: number | null;
  input_usd_per_million_default: number;
  output_usd_per_million_default: number;
  cache_read_multiplier_default: number;
  cache_write_multiplier_default: number;
}

type PriceField =
  | "input_usd_per_million"
  | "output_usd_per_million"
  | "cache_read_multiplier"
  | "cache_write_multiplier";

interface ListResponse {
  provider: string;
  region: string | null;
  filtering_active: boolean;
  models: ModelRow[];
}

interface ProbeResult {
  status: ProbeStatus;
  http_status: number | null;
  error: string | null;
}

type ProbeStatus =
  | "ok"
  | "not_servable"
  | "quota_exhausted"
  | "forbidden"
  | "error";

/**
 * Four compact inputs per row: Input $/M · Output $/M · Cache read × ·
 * Cache write ×. Each input shows the saved override when pinned and
 * the tier-classifier default as `placeholder` when empty — so the
 * operator sees "what we'd use if you don't pin a value" without
 * having to dig through code. Save fires onBlur when the value
 * actually changes; clearing the input PATCHes null which reverts to
 * the default at compute time.
 */
function PricingCell({
  row,
  disabled,
  onSave,
}: {
  row: ModelRow;
  disabled: boolean;
  onSave: (field: PriceField, value: number | null) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <PriceInput
        label="In $/M"
        saved={row.input_usd_per_million_saved}
        defaultValue={row.input_usd_per_million_default}
        disabled={disabled}
        onSave={(v) => onSave("input_usd_per_million", v)}
      />
      <PriceInput
        label="Out $/M"
        saved={row.output_usd_per_million_saved}
        defaultValue={row.output_usd_per_million_default}
        disabled={disabled}
        onSave={(v) => onSave("output_usd_per_million", v)}
      />
      <PriceInput
        label="Cache R ×"
        saved={row.cache_read_multiplier_saved}
        defaultValue={row.cache_read_multiplier_default}
        disabled={disabled}
        onSave={(v) => onSave("cache_read_multiplier", v)}
      />
      <PriceInput
        label="Cache W ×"
        saved={row.cache_write_multiplier_saved}
        defaultValue={row.cache_write_multiplier_default}
        disabled={disabled}
        onSave={(v) => onSave("cache_write_multiplier", v)}
      />
    </div>
  );
}

function PriceInput({
  label,
  saved,
  defaultValue,
  disabled,
  onSave,
}: {
  label: string;
  saved: number | null;
  defaultValue: number;
  disabled: boolean;
  onSave: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState<string>(
    saved === null ? "" : String(saved),
  );
  // Re-sync the input when the underlying row changes (e.g. another
  // tab edited the same model). String comparison handles "3" vs
  // "3.00" → don't clobber the operator's in-flight typing.
  useEffect(() => {
    setDraft(saved === null ? "" : String(saved));
    // We deliberately don't depend on `draft` — only the prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      // Clear → revert to default. Skip the call if there was nothing
      // pinned to begin with.
      if (saved !== null) onSave(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      // Bad input — bounce back to the last known good value.
      setDraft(saved === null ? "" : String(saved));
      return;
    }
    if (saved !== n) onSave(n);
  };

  const isCustom = saved !== null;

  return (
    <label className="flex flex-col gap-0.5">
      <span
        className={`text-[10px] font-medium uppercase tracking-wider ${
          isCustom ? "text-amber-300" : "text-fg-faint"
        }`}
        title={
          isCustom
            ? "Override pinned. Clear the input to revert to the tier default."
            : "Tier-classifier default. Type a value to pin an override."
        }
      >
        {label}
        {isCustom && " ·"}
      </span>
      <Input
        type="number"
        step="0.01"
        min={0}
        value={draft}
        placeholder={String(defaultValue)}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(saved === null ? "" : String(saved));
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="h-7 px-2 text-xs"
      />
    </label>
  );
}

const STATUS_VARIANT: Record<ProbeStatus, BadgeVariant> = {
  ok: "success",
  not_servable: "danger",
  quota_exhausted: "warning",
  forbidden: "danger",
  error: "warning",
};

const STATUS_LABEL: Record<ProbeStatus, string> = {
  ok: "Servable",
  not_servable: "Not servable",
  quota_exhausted: "Quota exhausted",
  forbidden: "Forbidden",
  error: "Error",
};

export function AnthropicModelsRoot() {
  const { status, fetchMe, isPlatformAdmin } = useAuthStore();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status !== "authenticated") return;
    void load();
  }, [status]);

  const load = async () => {
    try {
      const r = await apiFetch<ListResponse>("/api/admin/anthropic/models");
      setData(r);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  if (status === "authenticated" && !isPlatformAdmin) {
    return (
      <AppShell>
        <div className="p-8 text-sm text-fg-muted">
          Platform admin only.
        </div>
      </AppShell>
    );
  }

  const test = async (id: string) => {
    setBusyId(id);
    try {
      const r = await apiFetch<ProbeResult>(
        `/api/admin/anthropic/models/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              models: prev.models.map((m) =>
                m.id === id
                  ? {
                      ...m,
                      last_probe_status: r.status,
                      last_probe_error: r.error,
                      last_probed_at: new Date().toISOString(),
                    }
                  : m,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Save one price field. `value === null` clears the override and
   * the model falls back to the tier-classifier default the next
   * time the rollup runs. The api accepts a partial PATCH so we
   * only touch the field the operator changed.
   */
  const savePrice = async (
    id: string,
    field: PriceField,
    value: number | null,
  ) => {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/admin/anthropic/models/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              models: prev.models.map((m) =>
                m.id === id ? { ...m, [`${field}_saved`]: value } : m,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setBusyId(id);
    try {
      await apiFetch(`/api/admin/anthropic/models/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              models: prev.models.map((m) =>
                m.id === id ? { ...m, enabled } : m,
              ),
              filtering_active:
                enabled || prev.models.some((m) => m.enabled && m.id !== id),
            }
          : prev,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const breadcrumbs = [{ label: "Admin" }, { label: "Claude models" }];

  return (
    <AppShell breadcrumbs={breadcrumbs}>
      <div className="max-w-5xl space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Claude models</CardTitle>
            <CardDescription>
              Curate the list of Claude models the agent dropdown exposes.
              The catalog comes from your provider
              {data?.provider === "vertex"
                ? " (Agent Platform Model Garden, formerly Vertex AI)"
                : " (Anthropic /v1/models)"}
              {data?.region ? ` in ${data.region}` : ""}. Hit Test to
              run a 1-token probe; flip Enable to allow users to pick it.
              {data && !data.filtering_active && (
                <>
                  {" "}
                  <span className="text-amber-400">
                    No models enabled — the agent dropdown is empty. Hit
                    Test on a model that returns Servable, then flip
                    Enable.
                  </span>
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="mb-4 text-sm text-red-400">{error}</div>
            )}
            {!data && !error && (
              <div className="text-sm text-fg-faint">Loading…</div>
            )}
            {data && data.models.length === 0 && (
              <div className="text-sm text-fg-faint">
                Provider catalog is empty. Check ANTHROPIC_PROVIDER and
                credentials.
              </div>
            )}
            {data && data.models.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Probe</TableHead>
                    <TableHead className="w-24">Test</TableHead>
                    <TableHead>Pricing (USD/M tokens)</TableHead>
                    <TableHead className="w-24">Enabled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.models.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="font-medium">{m.label}</div>
                        <div className="font-mono text-[11px] text-fg-faint">
                          {m.id}
                        </div>
                      </TableCell>
                      <TableCell>
                        {m.last_probe_status ? (
                          <div className="space-y-1">
                            <Badge
                              variant={STATUS_VARIANT[m.last_probe_status]}
                            >
                              {STATUS_LABEL[m.last_probe_status]}
                            </Badge>
                            {m.last_probe_error && (
                              <div
                                className="max-w-md truncate font-mono text-[11px] text-fg-faint"
                                title={m.last_probe_error}
                              >
                                {m.last_probe_error}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-fg-faint/70">
                            not probed
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === m.id}
                          onClick={() => test(m.id)}
                        >
                          {busyId === m.id ? "…" : "Test"}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <PricingCell
                          row={m}
                          disabled={busyId === m.id}
                          onSave={(field, value) =>
                            savePrice(m.id, field, value)
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={m.enabled}
                            disabled={busyId === m.id}
                            onChange={(e) => toggle(m.id, e.target.checked)}
                          />
                          {m.enabled ? "On" : "Off"}
                        </label>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
