import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useSessionsStore } from "../../stores/sessionsStore";
import { usePendingPromptStore } from "../../stores/pendingPromptStore";
import { apiFetch } from "../../lib/api";
import { ComposerShell } from "./ComposerShell";
import { pickPreferredRuntimeModel } from "./runtime-model-default";
import type { RuntimeModelDTO, RuntimeType } from "@x1agent/shared";

interface Props {
  workspaceSlug: string;
  agentId: string;
  configuredRuntime?: RuntimeType;
  /** Optional agent label rendered in the lower-left status slot — the
   *  page header usually already names the agent, so default is empty. */
  agentLabel?: string;
}

/**
 * Compose-and-spawn for a specific agent. Drops onto the agent detail
 * page and the Edit page's General tab. No picker chip — the page's
 * route already pins the agent. Mirrors NewSessionComposer's pending-
 * prompt handoff: queue the prompt in sessionStorage by new session id,
 * navigate, SessionRoot drains it once the pod emits `session.started`.
 */
export function SpawnSessionCard({
  workspaceSlug,
  agentId,
  agentLabel,
  configuredRuntime = "claude_code",
}: Props) {
  const trigger = useSessionsStore((s) => s.trigger);
  const queuePendingPrompt = usePendingPromptStore((s) => s.set);
  const [prompt, setPrompt] = useState("");
  const [runtimeType, setRuntimeType] = useState<RuntimeType | null>(null);
  const [model, setModel] = useState("");
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRuntime = runtimeType ?? configuredRuntime;

  useEffect(() => {
    let cancelled = false;
    setModel("");
    void apiFetch<{ models: RuntimeModelDTO[]; default: string | null }>(
      `/api/capabilities/models?runtime_type=${selectedRuntime}`,
    )
      .then((res) => {
        if (!cancelled) {
          setRuntimeModels(res.models);
          setModel(
            pickPreferredRuntimeModel(selectedRuntime, res.models, res.default),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setRuntimeModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRuntime]);

  const onSubmit = async () => {
    if (busy) return;
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

  // We allow Run with no prompt (matches old behavior — the agent
  // boots and idles waiting for a turn). canSend is therefore !busy.
  const canSend = !busy;

  const leftSlot = (
    <div className="flex items-center gap-1">
      {agentLabel ? (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[13px] text-fg-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="truncate max-w-[180px]">{agentLabel}</span>
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-fg-muted transition hover:bg-bg-muted/60 hover:text-fg"
        >
          <span>{selectedRuntime === "codex" ? "Codex" : "Claude"}</span>
          <ChevronDown size={14} className="opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          <DropdownMenuItem onSelect={() => setRuntimeType(null)}>
            Agent default (
            {configuredRuntime === "codex" ? "Codex" : "Claude Code"})
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRuntimeType("claude_code")}>
            Claude Code
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRuntimeType("codex")}>
            Codex
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <select
        aria-label="Model override"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="w-32 rounded-md bg-transparent px-2 py-1 text-[13px] text-fg-muted outline-none placeholder:text-fg-faint focus:bg-bg-muted/60"
      >
        <option value="">Harness default</option>
        {runtimeModels.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
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
      placeholder={busy ? "Starting…" : "Start something new..."}
      error={error}
    />
  );
}
