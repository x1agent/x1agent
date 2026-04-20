import { useEffect } from "react";
import type { SessionDTO, SessionStatus } from "@x1agent/shared";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useSessionsStore } from "../../stores/sessionsStore";

interface Props {
  workspaceSlug: string;
  agentId: string | null;
}

const STATUS_VARIANT: Record<SessionStatus, BadgeVariant> = {
  pending: "secondary",
  running: "info",
  complete: "success",
  failed: "danger",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RunRow({
  session,
  workspaceSlug,
}: {
  session: SessionDTO;
  workspaceSlug: string;
}) {
  const who = session.triggered_by === "user" ? "manual" : "scheduler";
  return (
    <a
      href={`/workspaces/${workspaceSlug}/sessions/${session.id}`}
      className="flex items-center gap-3 border-t border-zinc-900 px-4 py-2 text-sm first:border-t-0 hover:bg-zinc-900/40"
    >
      <Badge variant={STATUS_VARIANT[session.status]}>{session.status}</Badge>
      <span className="text-zinc-400">{who}</span>
      <span className="ml-auto text-xs text-zinc-500">
        {fmtTime(session.triggered_at)}
      </span>
      {session.error_message && (
        <span className="text-xs text-red-400" title={session.error_message}>
          (error)
        </span>
      )}
    </a>
  );
}

/**
 * Recent runs list for a single agent. Spawning a new run lives in
 * SpawnSessionCard so the two concerns can sit independently on the
 * page — Run at the top, list further down.
 *
 * Poll-light: loads once on mount. Replace with a live subscription
 * when that lands.
 */
export function RecentRunsSection({ workspaceSlug, agentId }: Props) {
  const { byAgent, load } = useSessionsStore();

  useEffect(() => {
    if (agentId) load(workspaceSlug, agentId);
  }, [workspaceSlug, agentId, load]);

  if (!agentId) return null;

  const rows = byAgent[agentId] ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent runs</CardTitle>
        <CardDescription>
          Last 50 sessions, newest first. Scheduler ticks every 30s.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">
            No runs yet. Use the Run card above to trigger one.
          </div>
        ) : (
          <div>
            {rows.map((s) => (
              <RunRow key={s.id} session={s} workspaceSlug={workspaceSlug} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
