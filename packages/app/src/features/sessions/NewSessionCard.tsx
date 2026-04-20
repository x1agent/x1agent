import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useAgentsStore } from "../../stores/agentsStore";
import { usePendingPromptStore } from "../../stores/pendingPromptStore";
import { useSessionsStore } from "../../stores/sessionsStore";

interface Props {
  workspaceSlug: string;
}

/**
 * Spawn a new session from the workspace sessions page: pick an agent,
 * optionally type an initial prompt, click Run. Mirrors the Run card
 * on the agent detail page except the agent is chosen here rather
 * than implied by the page's route. Uses the same pending-prompt
 * handoff so the prompt auto-sends once the pod emits
 * `session.started`.
 */
export function NewSessionCard({ workspaceSlug }: Props) {
  const { bySlug: agentsBySlug, load: loadAgents } = useAgentsStore();
  const trigger = useSessionsStore((s) => s.trigger);
  const queuePendingPrompt = usePendingPromptStore((s) => s.set);

  const [agentId, setAgentId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAgents(workspaceSlug);
  }, [workspaceSlug, loadAgents]);

  const agents = (agentsBySlug[workspaceSlug] ?? []).filter((a) => a.is_active);

  // Seed the picker with the first agent once the list loads, so the
  // form is usable without a mandatory click. The user can still
  // switch before hitting Run.
  useEffect(() => {
    if (!agentId && agents.length > 0) {
      setAgentId(agents[0]!.id);
    }
  }, [agentId, agents]);

  const onRun = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!agentId) return;
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
        <CardTitle>New session</CardTitle>
        <CardDescription>
          Pick an agent, optionally start it with a prompt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onRun} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Label>Agent</Label>
            <Select
              value={agentId}
              onValueChange={setAgentId}
              disabled={agents.length === 0}
            >
              <SelectTrigger className="h-9 w-60 text-sm">
                <SelectValue
                  placeholder={
                    agents.length === 0 ? "No active agents" : "Pick an agent"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
            <Button type="submit" disabled={busy || !agentId}>
              {busy ? "Starting…" : prompt.trim() ? "Run with prompt" : "Run"}
            </Button>
          </div>
          {error && (
            <div className="text-sm text-red-400">{error}</div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
