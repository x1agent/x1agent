import { useEffect, useMemo, useState } from "react";
import {
  Braces,
  FileArchive,
  FileCode,
  FileText,
  Globe,
  Image as ImageIcon,
  Table as TableIcon,
} from "lucide-react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import {
  useWorkspaceSharesStore,
  type WorkspaceShareEntry,
} from "../../stores/workspaceSharesStore";
import { Badge } from "../../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

interface Props {
  workspaceSlug: string;
}

const TYPE_ICONS: Record<WorkspaceShareEntry["share_type"], typeof FileText> = {
  image: ImageIcon,
  svg: ImageIcon,
  site: Globe,
  csv: TableIcon,
  json: Braces,
  archive: FileArchive,
  code: FileCode,
  document: FileText,
  file: FileText,
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function WorkspaceSharesRoot({ workspaceSlug }: Props) {
  const { status: authStatus, fetchMe } = useAuthStore();
  const { bySlug, load, loadingSlug, errorBySlug } = useWorkspaceSharesStore();

  const [typeFilter, setTypeFilter] = useState<string>("all");
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
      if (!seen.has(r.agent.slug))
        seen.set(r.agent.slug, { slug: r.agent.slug, name: r.agent.name });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const types = useMemo(() => {
    const seen = new Set<WorkspaceShareEntry["share_type"]>();
    rows.forEach((r) => seen.add(r.share_type));
    return [...seen].sort();
  }, [rows]);

  const filtered = rows.filter((r) => {
    if (typeFilter !== "all" && r.share_type !== typeFilter) return false;
    if (agentFilter !== "all" && r.agent.slug !== agentFilter) return false;
    return true;
  });

  return (
    <AppShell>
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Shares</h1>
            <p className="mt-0.5 text-sm text-zinc-500">
              Every file an agent has published in this workspace.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Agent" />
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
          </div>
        </div>

        {err && (
          <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
            {err}
          </div>
        )}

        {loadingSlug === workspaceSlug && rows.length === 0 ? (
          <div className="text-sm text-zinc-500">Loading shares…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No shares yet. Shares appear here whenever an agent publishes a
            file with the share tool.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((s) => (
              <ShareRow
                key={`${s.session_id}:${s.share_id}`}
                entry={s}
                workspaceSlug={workspaceSlug}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ShareRow({
  entry,
  workspaceSlug,
}: {
  entry: WorkspaceShareEntry;
  workspaceSlug: string;
}) {
  const Icon = TYPE_ICONS[entry.share_type] ?? FileText;
  const sessionHref = `/workspaces/${workspaceSlug}/sessions/${entry.session_id}`;
  return (
    <a
      href={sessionHref}
      className="group flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/20 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900/60"
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-zinc-400" />
        <span className="truncate text-sm font-medium text-zinc-100">
          {entry.title}
        </span>
        <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
          {entry.share_type}
        </Badge>
      </div>
      <div className="text-xs text-zinc-500">
        <span className="text-zinc-400">{entry.agent.name}</span>
        <span className="mx-1.5">·</span>
        <span>{formatSize(entry.total_size)}</span>
        {entry.files.length > 1 && (
          <>
            <span className="mx-1.5">·</span>
            <span>{entry.files.length} files</span>
          </>
        )}
        <span className="mx-1.5">·</span>
        <span>{formatRelative(entry.created_at)}</span>
      </div>
      <div className="mt-2 truncate font-mono text-[10px] text-zinc-600">
        {entry.path}
      </div>
    </a>
  );
}
