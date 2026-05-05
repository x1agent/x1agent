import { useEffect, useMemo, useState } from "react";
import type { SessionStatus, WorkspaceSessionRow } from "@x1agent/shared";
import { ChevronDown, Trash2 } from "lucide-react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceSessionsStore } from "../../stores/workspaceSessionsStore";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useConfirm } from "../../components/use-confirm";
import { NewSessionComposer } from "./NewSessionComposer";

interface Props {
  workspaceSlug: string;
}

const STATUS_VARIANT: Record<SessionStatus, BadgeVariant> = {
  pending: "secondary",
  running: "info",
  complete: "success",
  failed: "danger",
};

const STATUS_FILTERS: { label: string; value: "all" | SessionStatus }[] = [
  { label: "All", value: "all" },
  { label: "Running", value: "running" },
  { label: "Complete", value: "complete" },
  { label: "Failed", value: "failed" },
  { label: "Pending", value: "pending" },
];

function fmtDuration(startIso: string, endIso: string | null): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const start = new Date(startIso).getTime();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WorkspaceSessionsRoot({ workspaceSlug }: Props) {
  const { status: authStatus, fetchMe } = useAuthStore();
  const { bySlug, load, loadingSlug, errorBySlug } = useWorkspaceSessionsStore();
  const bulkDelete = useWorkspaceSessionsStore((s) => s.bulkDelete);
  const { confirm, dialog } = useConfirm();

  const [statusFilter, setStatusFilter] = useState<"all" | SessionStatus>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authStatus === "idle") fetchMe();
  }, [authStatus, fetchMe]);

  useEffect(() => {
    if (authStatus === "anonymous" && typeof window !== "undefined") {
      window.location.href = "/";
    }
  }, [authStatus]);

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  const rows = bySlug[workspaceSlug] ?? [];
  const err = errorBySlug[workspaceSlug];

  const agents = useMemo(() => {
    const seen = new Map<string, { slug: string; name: string }>();
    for (const r of rows) {
      if (r.agent && !seen.has(r.agent.slug)) {
        seen.set(r.agent.slug, { slug: r.agent.slug, name: r.agent.name });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = rows.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (agentFilter !== "all" && r.agent?.slug !== agentFilter) return false;
    return true;
  });

  // Trim the selection to ids that still exist in the filtered view —
  // a status / agent filter change shouldn't carry stale selections,
  // and a bulk-delete shouldn't leave dangling ids in state.
  const filteredIds = useMemo(
    () => new Set(filtered.map((r) => r.id)),
    [filtered],
  );
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (filteredIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredIds]);

  function toggleOne(id: string, next: boolean) {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(id);
      else out.delete(id);
      return out;
    });
  }

  async function onDeleteSelected() {
    if (selected.size === 0) return;
    const ok = await confirm({
      title:
        selected.size === 1
          ? "Delete this session?"
          : `Delete ${selected.size} sessions?`,
      description:
        "Removes the session(s) and every event, token-usage row, share, and child session. This cannot be undone.",
      confirmText: "Delete",
    });
    if (!ok) return;
    setActionError(null);
    setBusy(true);
    const ids = Array.from(selected);
    try {
      await bulkDelete(workspaceSlug, ids);
      setSelected(new Set());
    } catch (e) {
      setActionError((e as Error).message);
      // Reload to recover from any optimistic rollback.
      void load(workspaceSlug);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "Sessions" },
      ]}
    >
      {dialog}
      <div className="mx-auto max-w-2xl px-6 pt-12 pb-12">
        <NewSessionComposer workspaceSlug={workspaceSlug} />

        <div className="mt-10">
          {/* Header row: title on the left, single status filter +
              agent filter + bulk actions on the right. Mirrors the
              home page's "Recent conversations" header shape. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium text-fg">Sessions</h2>
            <span className="text-xs text-fg-faint">
              {filtered.length} of {rows.length}
              {selected.size > 0 ? ` · ${selected.size} selected` : ""}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Select
                value={statusFilter}
                onValueChange={(v) =>
                  setStatusFilter(v as "all" | SessionStatus)
                }
              >
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {agents.length > 0 && (
                <Select value={agentFilter} onValueChange={setAgentFilter}>
                  <SelectTrigger className="h-8 w-[160px] text-xs">
                    <SelectValue placeholder="All agents" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.slug} value={a.slug}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {selected.size > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={busy}>
                      Actions
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        void onDeleteSelected();
                      }}
                      className="text-red-400 focus:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete {selected.size}
                      {selected.size === 1 ? " session" : " sessions"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {err && (
            <div className="mb-3 rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
              {err}
            </div>
          )}
          {actionError && (
            <div className="mb-3 rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
              {actionError}
            </div>
          )}

          {loadingSlug === workspaceSlug && rows.length === 0 && (
            <div className="text-sm text-fg-faint">Loading…</div>
          )}

          {filtered.length === 0 &&
            !(loadingSlug === workspaceSlug && rows.length === 0) && (
              <div className="rounded-md border border-border-soft p-8 text-center text-sm text-fg-faint">
                No sessions match the current filter.
              </div>
            )}

          {filtered.length > 0 && (
            <ul className="surface-card divide-y divide-border-soft overflow-hidden">
              {filtered.map((row) => (
                <SessionListItem
                  key={row.id}
                  row={row}
                  workspaceSlug={workspaceSlug}
                  selected={selected.has(row.id)}
                  onToggle={(next) => toggleOne(row.id, next)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function SessionListItem({
  row,
  workspaceSlug,
  selected,
  onToggle,
}: {
  row: WorkspaceSessionRow;
  workspaceSlug: string;
  selected: boolean;
  onToggle: (next: boolean) => void;
}) {
  // Same row shape as the workspace home's "Recent conversations":
  // surface bg, status pill on the right, agent name + relative time
  // on the left. Checkbox is hidden until hover (or when selected) so
  // the default state stays clean — bulk-select is rare; quick click
  // to drill in is the common path.
  return (
    <li>
      <a
        href={`/workspaces/${workspaceSlug}/sessions/${row.id}`}
        className="group flex items-center gap-3 px-4 py-3 transition hover:bg-bg-elevated/50"
      >
        <span
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle(!selected);
          }}
          className={`flex size-5 shrink-0 items-center justify-center transition ${
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onToggle(v === true)}
            aria-label={`Select session ${row.id}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">
            {row.agent?.name ?? "Untitled session"}
          </div>
          <div className="text-[11px] text-fg-faint">
            {row.triggered_by === "user"
              ? "manual"
              : row.triggered_by === "agent"
                ? "agent"
                : "scheduler"}
            {" · "}
            {fmtDuration(row.triggered_at, row.completed_at)}
            {" · "}
            {fmtTime(row.triggered_at)}
          </div>
        </div>
        <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
      </a>
    </li>
  );
}
