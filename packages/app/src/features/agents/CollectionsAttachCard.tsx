import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useCollectionsStore } from "../../stores/collectionsStore";

interface Props {
  workspaceSlug: string;
  agentId: string;
  agentName: string;
  canManage: boolean;
}

/**
 * Multi-select of the workspace's collections with a default-radio per
 * row. The UI builds the final desired set locally and hits PUT once
 * on save — matching the syncAgentAttachments application-layer
 * semantics (replace-set, default must be in set).
 */
export function CollectionsAttachCard({
  workspaceSlug,
  agentId,
  agentName,
  canManage,
}: Props) {
  const {
    bySlug,
    load,
    attachmentsByAgentKey,
    loadAttachments,
    syncAttachments,
  } = useCollectionsStore();

  const all = bySlug[workspaceSlug] ?? [];
  const key = `${workspaceSlug}:${agentId}`;
  const attachments = attachmentsByAgentKey[key] ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load(workspaceSlug);
    loadAttachments(workspaceSlug, agentId);
  }, [workspaceSlug, agentId, load, loadAttachments]);

  useEffect(() => {
    const initial = new Set(attachments.map((a) => a.id));
    setSelected(initial);
    setDefaultId(attachments.find((a) => a.is_default)?.id ?? null);
    setDirty(false);
  }, [attachments]);

  const rows = useMemo(() => {
    return all.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      provider: c.provider_type,
      description: c.description,
      selected: selected.has(c.id),
      isDefault: defaultId === c.id,
    }));
  }, [all, selected, defaultId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (defaultId === id) setDefaultId(null);
      } else {
        next.add(id);
      }
      return next;
    });
    setDirty(true);
  };

  const promoteDefault = (id: string) => {
    setSelected((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setDefaultId(id);
    setDirty(true);
  };

  const save = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await syncAttachments(workspaceSlug, agentId, {
        collection_ids: Array.from(selected),
        default_collection_id: defaultId,
      });
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Collections</CardTitle>
        <CardDescription>
          Knowledge stores <span className="text-zinc-200">{agentName}</span>{" "}
          can read and write. The default is the write target for any
          graph_write / vector_upsert that doesn't name a collection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {all.length === 0 && (
          <div className="rounded-md border border-zinc-900 p-4 text-sm text-zinc-500">
            No collections in this workspace. Create one at{" "}
            <a
              className="underline"
              href={`/workspaces/${workspaceSlug}/collections`}
            >
              Collections
            </a>
            .
          </div>
        )}

        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-3 rounded-md border border-zinc-900 px-3 py-2"
          >
            <input
              type="checkbox"
              checked={r.selected}
              disabled={!canManage || submitting}
              onChange={() => toggle(r.id)}
              className="h-4 w-4 accent-zinc-200"
              aria-label={`Attach ${r.name}`}
            />
            <div className="flex-1">
              <div className="text-sm text-zinc-100">{r.name}</div>
              <div className="text-xs text-zinc-500">
                {r.description ?? r.slug}
              </div>
            </div>
            <Badge variant="secondary">{r.provider}</Badge>
            <label className="flex items-center gap-1 text-xs text-zinc-400">
              <input
                type="radio"
                name={`default-${agentId}`}
                checked={r.isDefault}
                disabled={!canManage || !r.selected || submitting}
                onChange={() => promoteDefault(r.id)}
                className="h-3 w-3 accent-zinc-200"
              />
              default
            </label>
          </div>
        ))}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {canManage && all.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={save}
              disabled={!dirty || submitting}
              size="sm"
            >
              {submitting ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </Button>
            {dirty && (
              <span className="text-xs text-zinc-500">
                {selected.size}{" "}
                {selected.size === 1 ? "collection" : "collections"} selected
                {defaultId ? " (with a default)" : " (no default)"}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
