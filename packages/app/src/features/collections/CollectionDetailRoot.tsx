import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAuthStore } from "../../stores/authStore";
import { useCollectionsStore } from "../../stores/collectionsStore";

interface Props {
  workspaceSlug: string;
  collectionSlug: string;
}

export function CollectionDetailRoot({ workspaceSlug, collectionSlug }: Props) {
  const { status, fetchMe } = useAuthStore();
  const { bySlug, load } = useCollectionsStore();

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
  const collection = rows.find((c) => c.slug === collectionSlug);

  const breadcrumbs = [
    { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
    {
      label: "Collections",
      href: `/workspaces/${workspaceSlug}/collections`,
    },
    { label: collection?.name ?? collectionSlug },
  ];

  if (!collection) {
    return (
      <AppShell breadcrumbs={breadcrumbs}>
        <div className="p-6 text-sm text-zinc-500">
          {rows.length === 0 ? "Loading…" : "Collection not found."}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={breadcrumbs}>
      <div className="space-y-6 p-6 max-w-3xl">
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold">{collection.name}</h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
              <code className="font-mono">{collection.slug}</code>
              <span>·</span>
              <Badge variant="secondary">{collection.provider_type}</Badge>
            </div>
          </div>
        </div>

        {collection.description && (
          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent className="whitespace-pre-wrap text-sm text-zinc-200">
              {collection.description}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Backing store</CardTitle>
            <CardDescription>
              Provider-opaque identifier used when an attached agent reads or
              writes. Immutable after create.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Provider" value={collection.provider_type} />
            <Row label="Handle" value={collection.backend_handle} mono />
            <Row
              label="Created"
              value={new Date(collection.created_at).toLocaleString()}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Record types</CardTitle>
            <CardDescription>
              Seed types registered on provision. Agents can introduce new
              types at write time.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-zinc-400">
            Person, Organization, Project, Document, Meeting Note, Decision,
            Action Item. Live discovery via the graph provider lands in a
            later slice.
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={mono ? "font-mono text-zinc-200" : "text-zinc-200"}>
        {value}
      </div>
    </div>
  );
}
