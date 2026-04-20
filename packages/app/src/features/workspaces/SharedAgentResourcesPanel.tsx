import { useEffect, useMemo, useState } from "react";
import {
  useSharedResourcesStore,
  type InstalledResource,
} from "../../stores/sharedResourcesStore";
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

const STATUS_VARIANT: Record<InstalledResource["status"], BadgeVariant> = {
  provisioning: "info",
  running: "success",
  failed: "warning",
};

export function SharedAgentResourcesPanel({ slug, canManage }: Props) {
  const {
    catalogBySlug,
    installedBySlug,
    loadingSlug,
    errorBySlug,
    load,
    install,
    uninstall,
  } = useSharedResourcesStore();
  const catalog = catalogBySlug[slug] ?? [];
  const installed = installedBySlug[slug] ?? [];
  const loading = loadingSlug === slug && catalog.length === 0;
  const error = errorBySlug[slug] ?? null;

  // Local form state — short-lived and per-panel; does not belong in
  // the zustand store.
  const [kind, setKind] = useState<string>("postgres");
  const [version, setVersion] = useState<string>("");
  const [storageSize, setStorageSize] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    load(slug);
  }, [slug, load]);

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
      await install(slug, {
        kind,
        version,
        storage_size: storageSize,
      });
      setStorageSize("");
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
      await uninstall(slug, resource.id);
    } catch (err) {
      // Surface via submit error slot since it's the closest visible
      // error region; a dedicated toast would be next-level polish.
      setSubmitError((err as Error).message);
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
