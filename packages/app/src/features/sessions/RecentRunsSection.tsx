import { useEffect, useState } from "react";
import type { SessionDTO, SessionStatus } from "@x1agent/shared";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
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
 * Recent runs for an agent. Only visible once the agent exists (detail page).
 * Poll-light: loads on mount and after a trigger. Replace with SSE/NATS
 * later when live events land with the executor.
 */
export function RecentRunsSection({ workspaceSlug, agentId }: Props) {
  const { byAgent, load, trigger } = useSessionsStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agentId) load(workspaceSlug, agentId);
  }, [workspaceSlug, agentId, load]);

  if (!agentId) return null;

  const rows = byAgent[agentId] ?? [];

  const onRun = async () => {
    setError(null);
    setBusy(true);
    try {
      const session = await trigger(workspaceSlug, agentId);
      window.location.href = `/workspaces/${workspaceSlug}/sessions/${session.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>
              Last 50 sessions, newest first. Scheduler ticks every 30s.
            </CardDescription>
          </div>
          <Button type="button" onClick={onRun} disabled={busy}>
            {busy ? "Starting…" : "Run now"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && (
          <div className="px-4 pt-3 text-sm text-red-400">{error}</div>
        )}
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">
            No runs yet. Click "Run now" to trigger one.
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
