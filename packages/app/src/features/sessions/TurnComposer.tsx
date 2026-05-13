import { useState } from "react";
import { ComposerShell } from "./ComposerShell";

interface Props {
  onSend: (text: string, requestId?: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  /** Tiny status pill on the lower-left when present (e.g. "Working…",
   *  "Awaiting input"). Replaces the agent picker — agent is fixed at
   *  this point. */
  statusLabel?: string | null;
  /** Called when the user clicks the stop button while running.
   *  Renders a square stop button next to the Send button when both
   *  `running` is true AND `onStop` is set. */
  onStop?: () => void;
  /** Whether the session is currently running — surfaces the stop
   *  button. Distinct from `disabled` (which means the composer can't
   *  submit, e.g. terminal session). */
  running?: boolean;
}

/**
 * Composer for sending a follow-up turn into an in-flight session.
 * Replaces MessageInput.tsx's plain Input + Button strip. Same look as
 * NewSessionComposer; left slot shows a thin status label rather than
 * an agent picker since the agent is already chosen by this point.
 */
export function TurnComposer({
  onSend,
  disabled,
  placeholder,
  statusLabel,
  onStop,
  running,
}: Props) {
  const [text, setText] = useState("");

  const onSubmit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    // Loud failure: if the JetStream publish rejects (stream full,
    // broker unreachable, dedup conflict), log it to the browser
    // console so Sentry catches it via the global handler instead of
    // letting the message disappear silently. Surface in the UI is a
    // follow-up; this minimum ensures it's noisy in dev tools.
    void Promise.resolve(onSend(v)).catch((err) => {
      console.error("[composer] send failed", err);
    });
    setText("");
  };

  const canSend = !disabled && text.trim().length > 0;

  const leftSlot = statusLabel ? (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[13px] text-fg-faint">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg-faint" />
      <span className="truncate max-w-[240px]">{statusLabel}</span>
    </span>
  ) : null;

  return (
    <ComposerShell
      value={text}
      onChange={setText}
      onSubmit={onSubmit}
      leftSlot={leftSlot}
      disabled={!!disabled}
      busy={!!running}
      onStop={onStop}
      canSend={canSend}
      placeholder={placeholder ?? "Send a message to the agent…"}
      // No attach affordance in the in-session composer until we ship
      // turn attachments.
      showAttachButton={false}
      // No hint line — the chat area above already implies the contract.
      hint={null}
    />
  );
}
