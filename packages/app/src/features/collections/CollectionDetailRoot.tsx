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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useAuthStore } from "../../stores/authStore";
import { useCollectionsStore } from "../../stores/collectionsStore";
import type { CollectionDTO, RecordTypeDTO } from "@x1agent/shared";

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
  const {
    loadRecordTypes,
    recordTypesByKey,
    recordTypesErrorByKey,
    recordTypesLoadingKey,
  } = useCollectionsStore();

  useEffect(() => {
    if (collection) loadRecordTypes(workspaceSlug, collection.id);
  }, [workspaceSlug, collection?.id, loadRecordTypes]);

  const rtKey = collection ? `${workspaceSlug}:${collection.id}` : "";
  const recordTypes = recordTypesByKey[rtKey] ?? [];
  const rtLoading = recordTypesLoadingKey === rtKey;
  const rtError = recordTypesErrorByKey[rtKey] ?? null;

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

        <VectorIndexCard collection={collection} />

        <RecordTypesCard
          loading={rtLoading}
          error={rtError}
          types={recordTypes}
          workspaceSlug={workspaceSlug}
          collectionSlug={collectionSlug}
        />
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

function RecordTypesCard({
  loading,
  error,
  types,
  workspaceSlug,
  collectionSlug,
}: {
  loading: boolean;
  error: string | null;
  types: RecordTypeDTO[];
  workspaceSlug: string;
  collectionSlug: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Record types</CardTitle>
        <CardDescription>
          Live from the graph provider. Seed types come from the platform
          default registry; agents extend this at write time by introducing
          a new type.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {error && (
          <div className="px-4 py-3 text-sm text-red-400">{error}</div>
        )}
        {loading && types.length === 0 && (
          <div className="px-4 py-3 text-sm text-zinc-500">Loading…</div>
        )}
        {!loading && !error && types.length === 0 && (
          <div className="px-4 py-3 text-sm text-zinc-500">
            No record types registered.
          </div>
        )}
        {types.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Type</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead>Relationships</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((t) => (
                <TableRow
                  key={t.slug}
                  className="cursor-pointer hover:bg-zinc-900/40"
                  onClick={() => {
                    window.location.href = `/workspaces/${workspaceSlug}/collections/${collectionSlug}/types/${t.slug}`;
                  }}
                >
                  <TableCell>
                    <a
                      className="text-zinc-200 hover:underline"
                      href={`/workspaces/${workspaceSlug}/collections/${collectionSlug}/types/${t.slug}`}
                    >
                      {t.name}
                    </a>
                    <div className="font-mono text-[11px] text-zinc-600">
                      {t.slug}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {t.fields.length === 0 && (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                      {t.fields.map((f) => (
                        <Badge
                          key={f.name}
                          variant={f.required ? "info" : "secondary"}
                          title={`${f.type}${f.required ? " · required" : ""}`}
                        >
                          {f.name}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {t.relationships.length === 0 && (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                      {t.relationships.map((r) => (
                        <Badge
                          key={r.name}
                          variant="outline"
                          title={`→ ${r.targetType}`}
                        >
                          {r.edge}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function VectorIndexCard({
  collection,
}: {
  collection: { settings: Record<string, unknown> };
}) {
  const v = (collection.settings as {
    vector?: { dimension?: number; metric?: string };
  }).vector;
  if (!v?.dimension) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vector index</CardTitle>
        <CardDescription>
          Dimension and metric set at create time. Every embedding written
          here must match.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label="Dimension" value={String(v.dimension)} mono />
        <Row label="Metric" value={v.metric ?? "cosine"} mono />
      </CardContent>
    </Card>
  );
}
