import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  CreateCollectionRequest,
  VectorMetric,
} from "@x1agent/shared";
import { EMBEDDING_PRESETS } from "@x1agent/shared";
import { AppShell } from "../../shell/AppShell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
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
import { Textarea } from "../../components/ui/textarea";
import { useAuthStore } from "../../stores/authStore";
import { useCollectionsStore } from "../../stores/collectionsStore";
import {
  useCapabilitiesStore,
  useHasCollections,
} from "../../stores/capabilitiesStore";
import { useConfirm } from "../../components/use-confirm";

interface Props {
  workspaceSlug: string;
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CollectionsRoot({ workspaceSlug }: Props) {
  const { status, memberships, fetchMe } = useAuthStore();
  const {
    bySlug,
    loadingSlug,
    errorBySlug,
    load,
    create,
    remove,
  } = useCollectionsStore();

  const fetchCapabilities = useCapabilitiesStore((s) => s.fetch);
  const capsStatus = useCapabilitiesStore((s) => s.status);
  const hasCollections = useHasCollections();

  useEffect(() => {
    if (status === "idle") fetchMe();
    fetchCapabilities();
  }, [status, fetchMe, fetchCapabilities]);

  useEffect(() => {
    if (status === "anonymous" && typeof window !== "undefined") {
      window.location.href = "/";
    }
  }, [status]);

  useEffect(() => {
    // Only fetch when the deployment has a graph provider; otherwise
    // the api will return an empty list anyway and we want to show the
    // "not installed" state, not a generic empty list.
    if (hasCollections) load(workspaceSlug);
  }, [workspaceSlug, load, hasCollections]);

  if (capsStatus === "ready" && !hasCollections) {
    return (
      <AppShell
        breadcrumbs={[
          { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
          { label: "Collections" },
        ]}
      >
        <div className="mx-auto max-w-md p-8 text-sm text-zinc-400">
          <h1 className="mb-2 text-lg font-semibold text-zinc-100">
            Collections aren't installed
          </h1>
          <p>
            This deployment was configured without a graph provider, so
            collections are not available. Re-run <code>mise run configure</code>{" "}
            and pick a provider, then redeploy.
          </p>
        </div>
      </AppShell>
    );
  }

  const rows = bySlug[workspaceSlug] ?? [];
  const err = errorBySlug[workspaceSlug];
  const ws = memberships.find((m) => m.slug === workspaceSlug);
  const canManage = ws?.role === "admin" || ws?.role === "owner";

  const [showCreate, setShowCreate] = useState(false);
  const { confirm, dialog } = useConfirm();

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "Collections" },
      ]}
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="h-4 w-4" />
            <span className="ml-1">New collection</span>
          </Button>
        ) : undefined
      }
    >
      {dialog}
      <div className="space-y-6 p-6">
        <div className="max-w-3xl space-y-4">
          {showCreate && canManage && (
            <CreateCollectionCard
              workspaceSlug={workspaceSlug}
              onCreated={() => setShowCreate(false)}
              onCancel={() => setShowCreate(false)}
              create={create}
            />
          )}

          {err && (
            <Card className="border-red-900/50 bg-red-950/30">
              <CardContent className="py-3 text-sm text-red-300">
                {err}
              </CardContent>
            </Card>
          )}

          {loadingSlug === workspaceSlug && rows.length === 0 && (
            <div className="text-sm text-zinc-500">Loading…</div>
          )}

          {rows.length === 0 && loadingSlug !== workspaceSlug && (
            <div className="rounded-md border border-zinc-900 p-8 text-center text-sm text-zinc-500">
              No collections yet.
              {canManage && " Click \"New collection\" to create one."}
            </div>
          )}

          {rows.length > 0 && (
            <div className="overflow-hidden rounded-md border border-zinc-900">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Name</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Created</TableHead>
                    {canManage && <TableHead className="w-0" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} className="hover:bg-zinc-900/40">
                      <TableCell>
                        <a
                          className="text-zinc-100 hover:underline"
                          href={`/workspaces/${workspaceSlug}/collections/${row.slug}`}
                        >
                          {row.name}
                        </a>
                        <div className="font-mono text-[11px] text-zinc-600">
                          {row.slug}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{row.provider_type}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-zinc-400">
                        {row.description ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {new Date(row.created_at).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric", year: "numeric" },
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Delete collection ${row.name}?`,
                                description:
                                  "This also drops its backing store. Any data the agents have written to it is permanently lost.",
                                confirmText: "Delete",
                              });
                              if (ok) void remove(workspaceSlug, row.id);
                            }}
                            className="text-zinc-400 hover:text-red-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function CreateCollectionCard({
  workspaceSlug,
  onCreated,
  onCancel,
  create,
}: {
  workspaceSlug: string;
  onCreated: () => void;
  onCancel: () => void;
  create: (
    workspaceSlug: string,
    body: CreateCollectionRequest,
  ) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [description, setDescription] = useState("");
  // Default picks the first preset (OpenAI text-embedding-3-small / 1536).
  const [presetLabel, setPresetLabel] = useState<string>(
    EMBEDDING_PRESETS[0]!.label,
  );
  const [customDim, setCustomDim] = useState<string>("");
  const [metric, setMetric] = useState<VectorMetric>("cosine");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onNameChange = (v: string) => {
    setName(v);
    if (!slugDirty) setSlug(slugify(v));
  };

  const isCustom = presetLabel === "__custom__";
  const selectedPreset = EMBEDDING_PRESETS.find((p) => p.label === presetLabel);
  const dimension = isCustom
    ? Number(customDim) || 0
    : (selectedPreset?.dimension ?? 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!Number.isInteger(dimension) || dimension <= 0) {
      setError("Dimension must be a positive integer.");
      return;
    }
    setSubmitting(true);
    try {
      await create(workspaceSlug, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
        settings: { vector: { dimension, metric } },
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New collection</CardTitle>
        <CardDescription>
          Provisions a fresh SurrealDB-backed knowledge store. Agents
          attach in the collections card on an agent's detail page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="coll-name">Name</Label>
            <Input
              id="coll-name"
              required
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Ideas"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coll-slug">Slug</Label>
            <Input
              id="coll-slug"
              required
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugDirty(true);
              }}
              placeholder="ideas"
            />
            <p className="text-xs text-zinc-500">
              Lowercase, kebab-case, 1-63 chars. Becomes part of the URL and
              the backing-store id.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coll-desc">Description (optional)</Label>
            <Textarea
              id="coll-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What lives here?"
            />
          </div>

          <div className="space-y-3 rounded-md border border-zinc-900 p-3">
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              Embedding model
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coll-preset">Dimension</Label>
              <Select value={presetLabel} onValueChange={setPresetLabel}>
                <SelectTrigger id="coll-preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMBEDDING_PRESETS.map((p) => (
                    <SelectItem key={p.label} value={p.label}>
                      {p.label} ({p.dimension})
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">Custom dimension…</SelectItem>
                </SelectContent>
              </Select>
              {isCustom ? (
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={customDim}
                  onChange={(e) => setCustomDim(e.target.value)}
                  placeholder="e.g. 512"
                  className="mt-1"
                />
              ) : selectedPreset ? (
                <p className="text-xs text-zinc-500">
                  {selectedPreset.description}
                </p>
              ) : null}
              <p className="text-xs text-zinc-500">
                All embeddings written to this collection must match this
                dimension. Immutable after create.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coll-metric">Distance metric</Label>
              <Select
                value={metric}
                onValueChange={(v) => setMetric(v as VectorMetric)}
              >
                <SelectTrigger id="coll-metric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cosine">
                    cosine — the default for text embeddings
                  </SelectItem>
                  <SelectItem value="dot">
                    dot — when vectors are already normalised
                  </SelectItem>
                  <SelectItem value="l2">l2 — Euclidean distance</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && <div className="text-sm text-red-400">{error}</div>}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={submitting || !name || !slug}>
              {submitting ? "Creating…" : "Create collection"}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
