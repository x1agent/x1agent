import { useState } from "react";
import { X } from "lucide-react";
import { ComposerShell } from "./ComposerShell";
import {
  useUploadAttachments,
  type Attachment,
} from "../../hooks/useUploadAttachments";

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
  /** Optional — scopes uploads to this session so the row in the
   *  `uploads` table knows where it belongs. */
  sessionId?: string;
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
  sessionId,
}: Props) {
  const [text, setText] = useState("");
  const uploads = useUploadAttachments(sessionId);

  const onSubmit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    // V1: include the ready-upload IDs as a token suffix so the
    // backend sees what was attached. The wire-format parser (X1A-97)
    // takes over once it ships; for now, the agent prompt can parse
    // these manually if needed and the demo proves the attach-then-
    // submit flow end-to-end.
    const tokens = uploads.readyUploadIds.map((id) => `[image: ${id}]`).join(" ");
    const body = tokens ? `${v}\n\n${tokens}` : v;
    void Promise.resolve(onSend(body)).catch((err) => {
      console.error("[composer] send failed", err);
    });
    setText("");
    uploads.clear();
  };

  const canSend = !disabled && text.trim().length > 0 && !uploads.isUploading;

  const leftSlot = statusLabel ? (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[13px] text-fg-faint">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg-faint" />
      <span className="truncate max-w-[240px]">{statusLabel}</span>
    </span>
  ) : null;

  const pills =
    uploads.attachments.length > 0 ? (
      <>
        {uploads.attachments.map((a) => (
          <AttachmentPill
            key={a.key}
            attachment={a}
            onRemove={() => uploads.remove(a.key)}
          />
        ))}
      </>
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
      showAttachButton={false}
      hint={null}
      onFiles={(files) => void uploads.addFiles(files)}
      pills={pills}
      uploading={uploads.isUploading}
    />
  );
}

/**
 * In-prompt attachment pill. Matches the existing SharePill visual
 * weight at a smaller scale so it can sit inline with the text
 * comfortably. Renders three states: uploading (animated pulse on
 * the dot), ready (steady), failed (red + tooltip).
 */
function AttachmentPill({
  attachment: a,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const stateDot =
    a.status === "uploading"
      ? "bg-accent animate-pulse"
      : a.status === "failed"
      ? "bg-red-500"
      : "bg-emerald-500";
  return (
    <span
      className="inline-flex max-w-[200px] items-center gap-1.5 rounded-full border border-border-soft bg-bg-elevated px-2 py-0.5 text-[12px] text-fg-muted"
      title={
        a.status === "failed"
          ? a.error ?? "upload failed"
          : `${a.filename} (${formatSize(a.sizeBytes)})`
      }
      data-testid="attachment-pill"
      data-status={a.status}
    >
      <span className={`inline-block size-1.5 shrink-0 rounded-full ${stateDot}`} />
      <span className="truncate">{a.filename}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${a.filename}`}
        className="-mr-1 ml-0.5 grid size-4 shrink-0 place-items-center rounded-full text-fg-faint hover:bg-bg hover:text-fg"
      >
        <X size={10} strokeWidth={2.5} />
      </button>
    </span>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
