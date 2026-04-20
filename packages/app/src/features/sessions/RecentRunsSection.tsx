import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { SessionDTO, SessionStatus } from "@x1agent/shared";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useSessionsStore } from "../../stores/sessionsStore";
import { usePendingPromptStore } from "../../stores/pendingPromptStore";

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
  const queuePendingPrompt = usePendingPromptStore((s) => s.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (agentId) load(workspaceSlug, agentId);
  }, [workspaceSlug, agentId, load]);

  if (!agentId) return null;

  const rows = byAgent[agentId] ?? [];

  const onRun = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await trigger(workspaceSlug, agentId);
      // Queue the prompt so the session page can auto-send it once
      // the agent pod is up. The store persists to sessionStorage
      // (tab-scoped), so opening the session in a new tab won't
      // replay it.
      queuePendingPrompt(session.id, prompt);
      window.location.href = `/workspaces/${workspaceSlug}/sessions/${session.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const onPromptKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onRun();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent runs</CardTitle>
        <CardDescription>
          Last 50 sessions, newest first. Scheduler ticks every 30s.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <form
          onSubmit={onRun}
          className="flex flex-col gap-2 border-b border-zinc-900 p-4"
        >
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKeyDown}
            placeholder="Optional: message to start the session with. Leave blank to start silent."
            rows={3}
            className="resize-y"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-zinc-600">
              ⌘/Ctrl+Enter to run
            </span>
            <Button type="submit" disabled={busy}>
              {busy ? "Starting…" : prompt.trim() ? "Run with prompt" : "Run"}
            </Button>
          </div>
        </form>

        {error && (
          <div className="px-4 pt-3 text-sm text-red-400">{error}</div>
        )}
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">
            No runs yet. Write a prompt above and click "Run" to trigger one.
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
