import { useEffect, useState } from "react";
import type { SessionDTO, SessionStatus } from "@x1agent/shared";
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

const STATUS_STYLES: Record<SessionStatus, string> = {
  pending: "bg-zinc-700 text-zinc-200",
  running: "bg-blue-700 text-blue-50",
  complete: "bg-emerald-700 text-emerald-50",
  failed: "bg-red-800 text-red-50",
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

function RunRow({ session }: { session: SessionDTO }) {
  const who =
    session.triggered_by === "user" ? "manual" : "scheduler";
  return (
    <div className="flex items-center gap-3 border-t border-zinc-800 py-2 text-sm first:border-t-0">
      <span
        className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ${
          STATUS_STYLES[session.status]
        }`}
      >
        {session.status}
      </span>
      <span className="text-zinc-400">{who}</span>
      <span className="ml-auto text-xs text-zinc-500">
        {fmtTime(session.triggered_at)}
      </span>
      {session.error_message && (
        <span className="text-xs text-red-400" title={session.error_message}>
          (error)
        </span>
      )}
    </div>
  );
}

/**
 * Recent runs for an agent. Only visible once the agent exists (edit mode).
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
      await trigger(workspaceSlug, agentId);
      // Re-fetch so the list reflects the server's ordering.
      await load(workspaceSlug, agentId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
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
      <CardContent>
        {error && <div className="mb-2 text-sm text-red-400">{error}</div>}
        {rows.length === 0 ? (
          <div className="py-3 text-sm text-zinc-500">
            No runs yet. Click "Run now" to trigger one.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {rows.map((s) => (
              <RunRow key={s.id} session={s} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
