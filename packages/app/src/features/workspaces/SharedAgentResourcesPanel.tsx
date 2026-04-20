import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";

interface Props {
  slug: string;
  canManage: boolean;
}

interface CatalogEntry {
  kind: string;
  display_name: string;
  versions: string[];
  default_version: string;
  default_storage_size: string;
  available: boolean;
}

interface InstalledResource {
  id: string;
  kind: string;
  version: string;
  provider: string;
  status: "provisioning" | "running" | "failed";
  status_reason: string | null;
  created_at: string;
}

const STATUS_VARIANT: Record<InstalledResource["status"], BadgeVariant> = {
  provisioning: "info",
  running: "success",
  failed: "warning",
};

async function apiFetch<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function SharedAgentResourcesPanel({ slug, canManage }: Props) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<string>("postgres");
  const [version, setVersion] = useState<string>("");
  const [storageSize, setStorageSize] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const base = `/api/workspaces/${slug}/shared-agent-resources`;

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [c, l] = await Promise.all([
        apiFetch<{ entries: CatalogEntry[] }>(`${base}/catalog`),
        apiFetch<{ resources: InstalledResource[] }>(base),
      ]);
      setCatalog(c.entries);
      setInstalled(l.resources);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    reload();
  }, [reload]);

  const selectedEntry = useMemo(
    () => catalog.find((e) => e.kind === kind),
    [catalog, kind],
  );
  useEffect(() => {
    if (selectedEntry) {
      setVersion((v) => v || selectedEntry.default_version);
      setStorageSize((s) => s || selectedEntry.default_storage_size);
    }
  }, [selectedEntry]);

  const availableKinds = catalog.filter((e) => e.available);
  const installedKinds = new Set(installed.map((r) => r.kind));
  const installableKinds = availableKinds.filter(
    (e) => !installedKinds.has(e.kind),
  );

  const onInstall = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiFetch(base, {
        method: "POST",
        body: JSON.stringify({
          kind,
          version,
          config: { storage_size: storageSize },
        }),
      });
      setStorageSize("");
      await reload();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const onUninstall = async (resource: InstalledResource) => {
    const ok = window.confirm(
      `Uninstall ${resource.kind} ${resource.version}? This destroys every branch database; any data the agents have written is permanently lost.`,
    );
    if (!ok) return;
    try {
      await apiFetch(`${base}/${resource.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!canManage) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shared agent resources</CardTitle>
        <CardDescription>
          Long-running databases and caches your agents connect to. Each
          session gets an isolated per-branch slice. Separate from the
          x1agent control-plane database.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <div className="text-sm text-zinc-400">Loading…</div>}
        {error && <div className="text-sm text-red-400">{error}</div>}

        {installed.length > 0 && (
          <div className="overflow-hidden rounded-md border border-zinc-900">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Kind</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {installed.map((r) => (
                  <TableRow key={r.id} className="hover:bg-transparent">
                    <TableCell className="text-zinc-200">{r.kind}</TableCell>
                    <TableCell className="text-zinc-400">
                      {r.version}
                    </TableCell>
                    <TableCell className="text-zinc-400">
                      {r.provider}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status]}>
                        {r.status}
                      </Badge>
                      {r.status_reason && (
                        <span className="ml-2 text-xs text-zinc-500">
                          {r.status_reason}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onUninstall(r)}
                        className="text-xs text-zinc-400 hover:text-red-400"
                      >
                        Uninstall
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {installed.length === 0 && !loading && (
          <div className="rounded-md border border-zinc-900 p-6 text-center text-sm text-zinc-500">
            No resources installed. Pick one below to install.
          </div>
        )}

        {installableKinds.length > 0 && (
          <form
            onSubmit={onInstall}
            className="space-y-3 rounded-md border border-zinc-900 p-4"
          >
            <div className="text-sm font-medium text-zinc-200">
              Install from catalog
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex w-40 flex-col gap-1.5">
                <Label htmlFor="resource-kind">Kind</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v);
                    setVersion("");
                    setStorageSize("");
                  }}
                >
                  <SelectTrigger id="resource-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {installableKinds.map((e) => (
                      <SelectItem key={e.kind} value={e.kind}>
                        {e.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-32 flex-col gap-1.5">
                <Label htmlFor="resource-version">Version</Label>
                <Select value={version} onValueChange={setVersion}>
                  <SelectTrigger id="resource-version">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedEntry?.versions.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-32 flex-col gap-1.5">
                <Label htmlFor="resource-storage">Storage</Label>
                <Input
                  id="resource-storage"
                  value={storageSize}
                  onChange={(e) => setStorageSize(e.target.value)}
                  placeholder="20Gi"
                />
              </div>
              <Button type="submit" disabled={submitting || !version}>
                {submitting ? "Installing…" : "Install"}
              </Button>
            </div>
            {submitError && (
              <div className="text-sm text-red-400">{submitError}</div>
            )}
          </form>
        )}

        {catalog.length > 0 &&
          availableKinds.length === 0 &&
          installed.length === 0 && (
            <div className="text-sm text-zinc-500">
              No installers are wired in this deployment. Ask an operator to
              check the Kubernetes config.
            </div>
          )}
      </CardContent>
    </Card>
  );
}
