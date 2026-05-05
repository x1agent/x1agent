import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import cronstrue from "cronstrue";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAgentsStore } from "../../stores/agentsStore";
import { useConfirm } from "../../components/use-confirm";
import { cn } from "../../lib/utils";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

/**
 * Local minimum shape — `@x1agent/shared` doesn't export AgentRowDTO at
 * the package root in the current build (separate cleanup PR), so we
 * pin the row fields we actually consume here. Matches the wire shape
 * the api returns under /api/workspaces/:slug/agents.
 */
interface AgentRowDTO {
  id: string;
  slug: string;
  name: string;
  runtime_type: string;
  schedule: string | null;
  is_active: boolean;
}

/**
 * Render a cron expression in human language. Falls back to the raw
 * expression when cronstrue rejects it (legacy / non-standard syntax)
 * so the operator never sees an empty cell.
 */
function describeSchedule(schedule: string): string {
  try {
    return cronstrue.toString(schedule, { use24HourTimeFormat: true });
  } catch {
    return schedule;
  }
}

type StatusKind = "scheduled-active" | "scheduled-paused" | "manual";

function statusOf(agent: AgentRowDTO): StatusKind {
  if (!agent.schedule) return "manual";
  return agent.is_active ? "scheduled-active" : "scheduled-paused";
}

export function AgentsPanel({ workspaceSlug, canManage }: Props) {
  const { bySlug, loadingSlug, errorBySlug, load } = useAgentsStore();
  const update = useAgentsStore((s) => s.update);
  const rows = bySlug[workspaceSlug] ?? [];
  const error = errorBySlug[workspaceSlug];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  async function onTogglePause(agent: AgentRowDTO) {
    if (!canManage || busyId) return;
    const willPause = agent.is_active;
    const ok = await confirm({
      title: willPause
        ? `Pause ${agent.name}?`
        : `Resume ${agent.name}?`,
      description: willPause
        ? "Scheduled runs will be skipped until you resume. In-flight sessions are unaffected."
        : "The agent will fire on its next scheduled tick.",
      confirmText: willPause ? "Pause" : "Resume",
      variant: willPause ? "destructive" : "default",
    });
    if (!ok) return;
    setActionError(null);
    setBusyId(agent.id);
    try {
      await update(workspaceSlug, agent.id, { is_active: !willPause });
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      {dialog}
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle>Agents</CardTitle>
          <CardDescription>
            Configurable agent runtimes. Each can have a schedule, a system
            prompt, heartbeat instructions, and linked GitHub repos.
          </CardDescription>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <a href={`/workspaces/${workspaceSlug}/agents/new`}>New agent</a>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {loadingSlug === workspaceSlug && (
          <div className="text-sm text-fg-muted">Loading…</div>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
        {actionError && (
          <div className="text-sm text-red-400">{actionError}</div>
        )}
        {rows.length === 0 && loadingSlug !== workspaceSlug && (
          <div className="text-sm text-fg-faint">
            No agents yet. Create one to get started.
          </div>
        )}
        {rows.length > 0 && (
          <ul className="divide-y divide-border-soft rounded-md border border-border-soft">
            {rows.map((a) => (
              <AgentRow
                key={a.id}
                workspaceSlug={workspaceSlug}
                agent={a}
                canManage={canManage}
                busy={busyId === a.id}
                onTogglePause={() => onTogglePause(a)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AgentRow({
  workspaceSlug,
  agent,
  canManage,
  busy,
  onTogglePause,
}: {
  workspaceSlug: string;
  agent: AgentRowDTO;
  canManage: boolean;
  busy: boolean;
  onTogglePause: () => void;
}) {
  const status = statusOf(agent);

  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <a
          href={`/workspaces/${workspaceSlug}/agents/${agent.slug}`}
          className="text-fg hover:underline"
        >
          {agent.name}
        </a>
        <div className="text-xs text-fg-faint">
          {agent.runtime_type}
          {agent.schedule
            ? ` · ${describeSchedule(agent.schedule)}`
            : " · manual"}
        </div>
      </div>
      <StatusPill status={status} />
      <div className="hidden text-xs text-fg-faint sm:block">{agent.slug}</div>
      {canManage && agent.schedule && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onTogglePause}
          aria-label={
            status === "scheduled-paused"
              ? `Resume ${agent.name}`
              : `Pause ${agent.name}`
          }
          className="text-fg-muted hover:text-fg"
        >
          {status === "scheduled-paused" ? (
            <>
              <Play className="h-3.5 w-3.5" />
              Resume
            </>
          ) : (
            <>
              <Pause className="h-3.5 w-3.5" />
              Pause
            </>
          )}
        </Button>
      )}
    </li>
  );
}

function StatusPill({ status }: { status: StatusKind }) {
  // Status conveyed redundantly by color + glyph + text so the cell is
  // never ambiguous: the dot color and the label always agree.
  const cfg =
    status === "scheduled-active"
      ? {
          // Filled green dot — actively scheduled, will fire next tick.
          dot: "bg-emerald-500",
          ring: "",
          label: "Running",
          color: "text-emerald-300",
        }
      : status === "scheduled-paused"
        ? {
            // Filled amber dot — schedule exists but paused; fires on resume.
            dot: "bg-amber-500",
            ring: "",
            label: "Paused",
            color: "text-amber-300",
          }
        : {
            // Hollow zinc dot — no schedule; only runs when triggered manually.
            dot: "bg-transparent",
            ring: "ring-1 ring-zinc-600",
            label: "Manual",
            color: "text-fg-muted",
          };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium",
        cfg.color,
      )}
    >
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", cfg.dot, cfg.ring)}
        aria-hidden="true"
      />
      {cfg.label}
    </span>
  );
}
