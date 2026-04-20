import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { useSessionsStore } from "../../stores/sessionsStore";
import { usePendingPromptStore } from "../../stores/pendingPromptStore";

interface Props {
  workspaceSlug: string;
  agentId: string;
}

/**
 * Spawn a session for a specific agent. Lives at the top of the agent
 * detail page and the Edit page's General tab. Mirrors
 * NewSessionCard's pending-prompt handoff: stash the prompt in
 * sessionStorage keyed by the new session id, navigate, and
 * SessionRoot drains it once the pod emits `session.started`.
 *
 * The page with an agent in its route uses this; the workspace-level
 * sessions page uses NewSessionCard (same flow, plus an agent
 * picker).
 */
export function SpawnSessionCard({ workspaceSlug, agentId }: Props) {
  const trigger = useSessionsStore((s) => s.trigger);
  const queuePendingPrompt = usePendingPromptStore((s) => s.set);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRun = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await trigger(workspaceSlug, agentId);
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
        <CardTitle>Run</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onRun} className="flex flex-col gap-2">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKeyDown}
            placeholder="User prompt"
            rows={2}
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
          {error && <div className="text-sm text-red-400">{error}</div>}
        </form>
      </CardContent>
    </Card>
  );
}
