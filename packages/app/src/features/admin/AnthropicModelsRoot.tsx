import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
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
}

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
        <div className="p-8 text-sm text-zinc-400">
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
              <div className="text-sm text-zinc-500">Loading…</div>
            )}
            {data && data.models.length === 0 && (
              <div className="text-sm text-zinc-500">
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
                    <TableHead className="w-32">Test</TableHead>
                    <TableHead className="w-32">Enabled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.models.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="font-medium">{m.label}</div>
                        <div className="font-mono text-[11px] text-zinc-500">
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
                                className="max-w-md truncate font-mono text-[11px] text-zinc-500"
                                title={m.last_probe_error}
                              >
                                {m.last_probe_error}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-600">
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
