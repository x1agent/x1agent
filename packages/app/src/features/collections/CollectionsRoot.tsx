import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CreateCollectionRequest } from "@x1agent/shared";
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

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === "anonymous" && typeof window !== "undefined") {
      window.location.href = "/";
    }
  }, [status]);

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  const rows = bySlug[workspaceSlug] ?? [];
  const err = errorBySlug[workspaceSlug];
  const ws = memberships.find((m) => m.slug === workspaceSlug);
  const canManage = ws?.role === "admin" || ws?.role === "owner";

  const [showCreate, setShowCreate] = useState(false);

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
                            onClick={() => {
                              if (
                                confirm(
                                  `Delete collection ${row.name}? This also drops its backing store.`,
                                )
                              )
                                void remove(workspaceSlug, row.id);
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onNameChange = (v: string) => {
    setName(v);
    if (!slugDirty) setSlug(slugify(v));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await create(workspaceSlug, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
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
