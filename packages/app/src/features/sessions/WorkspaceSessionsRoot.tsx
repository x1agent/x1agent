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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
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
import { NewSessionCard } from "./NewSessionCard";

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

  const allSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const someSelected = selected.size > 0 && !allSelected;
  const headerCheckedState: boolean | "indeterminate" = allSelected
    ? true
    : someSelected
      ? "indeterminate"
      : false;

  function toggleAll(next: boolean) {
    setSelected((prev) => {
      if (!next) {
        // Clear only ids that are visible in the current filter; leave
        // anything outside it untouched (defensive — can't actually
        // happen because the effect above prunes).
        const out = new Set(prev);
        for (const r of filtered) out.delete(r.id);
        return out;
      }
      const out = new Set(prev);
      for (const r of filtered) out.add(r.id);
      return out;
    });
  }

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
      <div className="space-y-4 p-6">
        <NewSessionCard workspaceSlug={workspaceSlug} />

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border border-zinc-900 bg-zinc-950 p-1">
            {STATUS_FILTERS.map((f) => (
              <Button
                key={f.value}
                type="button"
                variant={statusFilter === f.value ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setStatusFilter(f.value)}
                className="h-7 px-2 text-xs"
              >
                {f.label}
              </Button>
            ))}
          </div>
          {agents.length > 0 && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
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
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    void onDeleteSelected();
                  }}
                  className="text-red-300 focus:text-red-200"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete {selected.size}
                  {selected.size === 1 ? " session" : " sessions"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="ml-auto text-xs text-zinc-500">
            {selected.size > 0
              ? `${selected.size} selected · ${filtered.length} of ${rows.length} sessions`
              : `${filtered.length} of ${rows.length} sessions`}
          </span>
        </div>

        {err && (
          <div className="rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
            {err}
          </div>
        )}

        {actionError && (
          <div className="rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
            {actionError}
          </div>
        )}

        {loadingSlug === workspaceSlug && rows.length === 0 && (
          <div className="text-sm text-zinc-500">Loading…</div>
        )}

        {filtered.length === 0 && !(loadingSlug === workspaceSlug && rows.length === 0) && (
          <div className="rounded-md border border-zinc-900 p-8 text-center text-sm text-zinc-500">
            No sessions match the current filter.
          </div>
        )}

        {filtered.length > 0 && (
          <div className="overflow-hidden rounded-md border border-zinc-900">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">
                    <Checkbox
                      checked={headerCheckedState}
                      onCheckedChange={(v) => toggleAll(v === true)}
                      aria-label={
                        allSelected
                          ? "Clear all selected sessions"
                          : "Select all sessions in view"
                      }
                    />
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <SessionRow
                    key={row.id}
                    row={row}
                    workspaceSlug={workspaceSlug}
                    selected={selected.has(row.id)}
                    onToggle={(next) => toggleOne(row.id, next)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function SessionRow({
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
  return (
    <TableRow
      className="cursor-pointer"
      onClick={() => {
        window.location.href = `/workspaces/${workspaceSlug}/sessions/${row.id}`;
      }}
    >
      <TableCell
        className="w-10"
        onClick={(e) => {
          // Don't navigate when the user clicks anywhere in the
          // checkbox cell; that's the affordance for selection, not
          // drilling into the session.
          e.stopPropagation();
        }}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onToggle(v === true)}
          aria-label={`Select session ${row.id}`}
        />
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
      </TableCell>
      <TableCell>
        {row.agent ? (
          <span className="text-zinc-200">{row.agent.name}</span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </TableCell>
      <TableCell className="text-zinc-400">
        {row.triggered_by === "user"
          ? "manual"
          : row.triggered_by === "agent"
            ? "agent"
            : "scheduler"}
      </TableCell>
      <TableCell className="text-zinc-400">
        {fmtDuration(row.triggered_at, row.completed_at)}
      </TableCell>
      <TableCell className="text-zinc-500">
        {fmtTime(row.triggered_at)}
      </TableCell>
    </TableRow>
  );
}
