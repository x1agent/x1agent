import { useState } from "react";
import { useSessionsStore } from "../../stores/sessionsStore";
import { usePendingPromptStore } from "../../stores/pendingPromptStore";
import { ComposerShell } from "./ComposerShell";

interface Props {
  workspaceSlug: string;
  agentId: string;
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
export function SpawnSessionCard({ workspaceSlug, agentId, agentLabel }: Props) {
  const trigger = useSessionsStore((s) => s.trigger);
  const queuePendingPrompt = usePendingPromptStore((s) => s.set);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (busy) return;
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

  // We allow Run with no prompt (matches old behavior — the agent
  // boots and idles waiting for a turn). canSend is therefore !busy.
  const canSend = !busy;

  const leftSlot = agentLabel ? (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[13px] text-fg-muted">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
      <span className="truncate max-w-[240px]">{agentLabel}</span>
    </span>
  ) : null;

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
