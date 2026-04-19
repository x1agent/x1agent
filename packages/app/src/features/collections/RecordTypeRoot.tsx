import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { RecordDTO } from "@x1agent/shared";
import { AppShell } from "../../shell/AppShell";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
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

interface Props {
  workspaceSlug: string;
  collectionSlug: string;
  typeSlug: string;
}

/**
 * Per-record-type browser. Shows all records of the named type in a
 * table; clicking a row expands inline to show Fields / Relationships
 * / Provenance (same three-column layout the reference uses). Search
 * filters on the stringified record.
 */
export function RecordTypeRoot({
  workspaceSlug,
  collectionSlug,
  typeSlug,
}: Props) {
  const { status, fetchMe } = useAuthStore();
  const {
    bySlug,
    load,
    loadRecordTypes,
    recordTypesByKey,
    loadRecords,
    recordsByKey,
    recordsErrorByKey,
    recordsLoadingKey,
  } = useCollectionsStore();

  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  useEffect(() => {
    if (collection) {
      loadRecordTypes(workspaceSlug, collection.id);
      loadRecords(workspaceSlug, collection.id, typeSlug);
    }
  }, [workspaceSlug, collection?.id, typeSlug, loadRecordTypes, loadRecords]);

  const types =
    (collection ? recordTypesByKey[`${workspaceSlug}:${collection.id}`] : null) ??
    [];
  const typeInfo = types.find((t) => t.slug === typeSlug);

  const recordKey = collection
    ? `${workspaceSlug}:${collection.id}:${typeSlug}`
    : "";
  const records = recordsByKey[recordKey] ?? [];
  const loading = recordsLoadingKey === recordKey;
  const error = recordsErrorByKey[recordKey] ?? null;

  const filtered = useMemo(() => {
    if (!search) return records;
    const needle = search.toLowerCase();
    return records.filter((r) =>
      JSON.stringify(r).toLowerCase().includes(needle),
    );
  }, [records, search]);

  // Column selection: union of every key that shows up on any record,
  // minus id/_provenance (already in their own cells), sorted with
  // common identity fields first so Name sits at the left even when
  // the record-type schema doesn't declare it. Capped at 5.
  const columns = useMemo(() => {
    if (records.length === 0) return ["name"];
    const keys = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r.data)) {
        if (k !== "id" && !k.startsWith("_")) keys.add(k);
      }
    }
    const priority = [
      "name",
      "title",
      "email",
      "role",
      "domain",
      "industry",
      "status",
      "summary",
    ];
    const sorted = [...keys].sort((a, b) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    });
    return sorted.slice(0, 5);
  }, [records]);

  const breadcrumbs = [
    { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
    {
      label: "Collections",
      href: `/workspaces/${workspaceSlug}/collections`,
    },
    {
      label: collection?.name ?? collectionSlug,
      href: `/workspaces/${workspaceSlug}/collections/${collectionSlug}`,
    },
    { label: typeInfo?.name ?? typeSlug },
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
      <div className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {typeInfo?.name ?? typeSlug}
          </h1>
          <Badge variant="secondary">
            {records.length}{" "}
            {records.length === 1 ? "record" : "records"}
          </Badge>
          <code className="font-mono text-xs text-zinc-500">{typeSlug}</code>
        </div>

        {typeInfo?.description && (
          <p className="max-w-3xl text-sm text-zinc-400">
            {typeInfo.description}
          </p>
        )}

        {typeInfo && (typeInfo.fields.length > 0 || typeInfo.relationships.length > 0) && (
          <Card>
            <CardContent className="space-y-3 p-4 text-sm">
              {typeInfo.fields.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-zinc-500">
                    Fields
                  </span>
                  {typeInfo.fields.map((f) => (
                    <Badge
                      key={f.name}
                      variant={f.required ? "info" : "secondary"}
                      title={`${f.type}${f.required ? " · required" : ""}`}
                    >
                      {f.name}
                    </Badge>
                  ))}
                </div>
              )}
              {typeInfo.relationships.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-zinc-500">
                    Relationships
                  </span>
                  {typeInfo.relationships.map((r) => (
                    <Badge
                      key={r.name}
                      variant="outline"
                      title={`→ ${r.targetType}`}
                    >
                      {r.edge}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {records.length > 0 && (
          <div className="relative max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${typeInfo?.name ?? typeSlug}…`}
              className="h-9 pl-8 text-sm"
            />
          </div>
        )}

        {error && (
          <Card className="border-red-900/50 bg-red-950/30">
            <CardContent className="py-3 text-sm text-red-300">
              {error}
            </CardContent>
          </Card>
        )}

        {loading && records.length === 0 && (
          <div className="text-sm text-zinc-500">Loading…</div>
        )}

        {!loading && !error && records.length === 0 && (
          <div className="rounded-md border border-dashed border-zinc-900 p-8 text-center text-sm text-zinc-500">
            No {typeInfo?.name ?? typeSlug} records yet. Use an agent session
            to create them.
          </div>
        )}

        {records.length > 0 && (
          <div className="overflow-hidden rounded-md border border-zinc-900">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-8" />
                  {columns.map((col) => (
                    <TableHead key={col} className="capitalize">
                      {col.replace(/_/g, " ")}
                    </TableHead>
                  ))}
                  <TableHead>Confidence</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const expanded = expandedId === r.id;
                  return (
                    <Fragment key={r.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setExpandedId(expanded ? null : r.id)
                        }
                      >
                        <TableCell className="w-8">
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
                          )}
                        </TableCell>
                        {columns.map((col) => (
                          <TableCell key={col} className="text-sm text-zinc-200">
                            {renderValue(r.data[col])}
                          </TableCell>
                        ))}
                        <TableCell>
                          <Badge
                            variant={
                              r.provenance.confidence >= 0.9
                                ? "success"
                                : "secondary"
                            }
                          >
                            {Math.round(r.provenance.confidence * 100)}%
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-xs text-zinc-500">
                          {r.provenance.createdAt
                            ? new Date(
                                r.provenance.createdAt,
                              ).toLocaleDateString()
                            : "—"}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell
                            colSpan={columns.length + 3}
                            className="bg-zinc-950 p-4"
                          >
                            <RecordDetail
                              record={r}
                              workspaceSlug={workspaceSlug}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {filtered.length === 0 && search && (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length + 3}
                      className="text-center text-sm text-zinc-500"
                    >
                      No matches for &ldquo;{search}&rdquo;
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function renderValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span className="text-zinc-600">—</span>;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v))
    return (
      <span className="text-zinc-400">[{v.length} item{v.length === 1 ? "" : "s"}]</span>
    );
  return (
    <span className="font-mono text-[11px] text-zinc-500">
      {JSON.stringify(v).slice(0, 40)}
      {JSON.stringify(v).length > 40 ? "…" : ""}
    </span>
  );
}

function RecordDetail({
  record,
  workspaceSlug,
}: {
  record: RecordDTO;
  workspaceSlug: string;
}) {
  const sessionId = record.provenance.createdBy.replace(/^session:/, "");
  const fieldEntries = Object.entries(record.data);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div>
        <h4 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Fields
        </h4>
        <div className="space-y-1.5 rounded-md border border-zinc-900 bg-zinc-950 p-3 text-xs">
          {fieldEntries.length === 0 && (
            <span className="text-zinc-600">No fields</span>
          )}
          {fieldEntries.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <span className="capitalize text-zinc-500">
                {k.replace(/_/g, " ")}
              </span>
              <span className="truncate text-right text-zinc-200">
                {typeof v === "string" || typeof v === "number" || typeof v === "boolean"
                  ? String(v)
                  : JSON.stringify(v)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-1 text-[11px] text-zinc-600">
          id: <code className="font-mono">{record.id}</code>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Relationships
        </h4>
        <div className="rounded-md border border-zinc-900 bg-zinc-950 p-3 text-xs text-zinc-500">
          Walking outgoing + incoming edges lands in a follow-up slice.
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Provenance
        </h4>
        <div className="space-y-1.5 rounded-md border border-zinc-900 bg-zinc-950 p-3 text-xs">
          <div className="flex justify-between gap-4">
            <span className="text-zinc-500">Source</span>
            <span className="text-zinc-200">
              {record.provenance.source ?? "—"}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-zinc-500">Confidence</span>
            <Badge
              variant={
                record.provenance.confidence >= 0.9 ? "success" : "secondary"
              }
            >
              {Math.round(record.provenance.confidence * 100)}%
            </Badge>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-zinc-500">Session</span>
            {sessionId && sessionId !== record.provenance.createdBy ? (
              <a
                href={`/workspaces/${workspaceSlug}/sessions/${sessionId}`}
                className="font-mono text-[11px] text-zinc-200 hover:underline"
              >
                {sessionId.slice(0, 8)}
              </a>
            ) : (
              <span className="font-mono text-[11px] text-zinc-500">—</span>
            )}
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-zinc-500">Created</span>
            <span className="text-zinc-200">
              {record.provenance.createdAt
                ? new Date(record.provenance.createdAt).toLocaleString()
                : "—"}
            </span>
          </div>
          {record.provenance.derivedFrom.length > 0 && (
            <div className="flex justify-between gap-4">
              <span className="text-zinc-500">Derived from</span>
              <span className="font-mono text-[11px] text-zinc-300">
                {record.provenance.derivedFrom.join(", ")}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
