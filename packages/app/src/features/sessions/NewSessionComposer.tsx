import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useAgentsStore } from "../../stores/agentsStore";
import { usePendingPromptStore } from "../../stores/pendingPromptStore";
import { useSessionsStore } from "../../stores/sessionsStore";
import { apiFetch } from "../../lib/api";
import { ComposerShell } from "./ComposerShell";
import type { RuntimeModelDTO, RuntimeType } from "@x1agent/shared";

interface Props {
  workspaceSlug: string;
  placeholder?: string;
}

/**
 * Composer for spawning a new session: agent picker chip on the left,
 * prompt textarea, send. On submit it creates the session, queues the
 * prompt to auto-send once the pod emits `session.started`, then
 * navigates to the session detail page.
 */
export function NewSessionComposer({ workspaceSlug, placeholder }: Props) {
  const { bySlug: agentsBySlug, load: loadAgents } = useAgentsStore();
  const trigger = useSessionsStore((s) => s.trigger);
  const queuePendingPrompt = usePendingPromptStore((s) => s.set);

  const [agentId, setAgentId] = useState<string>("");
  const [runtimeType, setRuntimeType] = useState<RuntimeType | null>(null);
  const [model, setModel] = useState("");
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelDTO[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAgents(workspaceSlug);
  }, [workspaceSlug, loadAgents]);

  const agents = (agentsBySlug[workspaceSlug] ?? []).filter((a) => a.is_active);
  const activeAgent = agents.find((a) => a.id === agentId) ?? agents[0];

  useEffect(() => {
    if (!agentId && agents.length > 0) {
      setAgentId(agents[0]!.id);
    }
  }, [agentId, agents]);

  const selectedRuntime = runtimeType ?? (activeAgent as { runtime_type?: RuntimeType } | undefined)?.runtime_type ?? "claude_code";

  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ models: RuntimeModelDTO[] }>(
      `/api/capabilities/models?runtime_type=${selectedRuntime}`,
    )
      .then((res) => {
        if (!cancelled) setRuntimeModels(res.models);
      })
      .catch(() => {
        if (!cancelled) setRuntimeModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRuntime]);

  const onSubmit = async () => {
    if (!agentId || busy) return;
    setError(null);
    setBusy(true);
    try {
      const session = await trigger(workspaceSlug, agentId, runtimeType, model);
      queuePendingPrompt(session.id, prompt);
      window.location.href = `/workspaces/${workspaceSlug}/sessions/${session.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const canSend = !!agentId && !busy && prompt.trim().length > 0;

  const leftSlot = (
    <div className="flex items-center gap-1">
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        disabled={agents.length === 0}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-fg-muted hover:text-fg hover:bg-bg-muted/60 disabled:opacity-50 disabled:hover:bg-transparent transition"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span className="truncate max-w-[200px]">
          {activeAgent?.name ??
            (agents.length === 0 ? "No active agents" : "Pick agent")}
        </span>
        <ChevronDown size={14} className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {agents.map((a) => (
          <DropdownMenuItem
            key={a.id}
            onSelect={() => setAgentId(a.id)}
            className="text-sm"
          >
            {a.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-fg-muted hover:text-fg hover:bg-bg-muted/60 transition"
      >
        <span className="truncate max-w-[120px]">
          {selectedRuntime === "codex" ? "Codex" : "Claude"}
        </span>
        <ChevronDown size={14} className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        <DropdownMenuItem onSelect={() => setRuntimeType(null)}>
          Agent default
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setRuntimeType("claude_code")}>
          Claude Code
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setRuntimeType("codex")}>
          Codex
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <input
      aria-label="Model override"
      value={model}
      onChange={(e) => setModel(e.target.value)}
      placeholder="Default model"
      list="session-runtime-models"
      className="w-32 rounded-md bg-transparent px-2 py-1 text-[13px] text-fg-muted outline-none placeholder:text-fg-faint focus:bg-bg-muted/60"
    />
    <datalist id="session-runtime-models">
      {runtimeModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
    </datalist>
    </div>
  );

  return (
    <ComposerShell
      value={prompt}
      onChange={setPrompt}
      onSubmit={onSubmit}
      leftSlot={leftSlot}
      busy={busy}
      canSend={canSend}
      placeholder={placeholder ?? "Start something new..."}
      error={error}
    />
  );
}
