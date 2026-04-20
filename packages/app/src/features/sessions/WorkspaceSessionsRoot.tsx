import { useEffect, useMemo, useState } from "react";
import type { SessionStatus, WorkspaceSessionRow } from "@x1agent/shared";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceSessionsStore } from "../../stores/workspaceSessionsStore";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
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

  const [statusFilter, setStatusFilter] = useState<"all" | SessionStatus>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");

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

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "Sessions" },
      ]}
    >
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
          <span className="ml-auto text-xs text-zinc-500">
            {filtered.length} of {rows.length} sessions
          </span>
        </div>

        {err && (
          <div className="rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
            {err}
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
}: {
  row: WorkspaceSessionRow;
  workspaceSlug: string;
}) {
  return (
    <TableRow
      className="cursor-pointer"
      onClick={() => {
        window.location.href = `/workspaces/${workspaceSlug}/sessions/${row.id}`;
      }}
    >
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
