import {
  forwardRef,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Plus, Pause, ArrowUp, Upload } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Lower-left content — agent chip, model picker, etc. */
  leftSlot?: ReactNode;
  /** Right-side actions extra to the built-in send/stop. Rendered before
   *  the send button. Used by TurnComposer for nothing today, kept for
   *  future affordances (cancel-turn, retry, etc.). */
  rightExtras?: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  canSend?: boolean;
  placeholder?: string;
  /** Show the disabled "+" attachments slot. Default true on the new-
   *  session composer, false in dense in-session contexts. */
  showAttachButton?: boolean;
  /** Footer hint line. Pass null to hide. */
  hint?: ReactNode;
  /** Inline error rendered above the hint. */
  error?: string | null;
  onStop?: () => void;
  /**
   * X1A-98 — drag/drop hand-off. Caller wires this to the upload
   * hook; ComposerShell handles the drag-over visual but the parent
   * owns the upload state machine.
   */
  onFiles?: (files: FileList) => void;
  /** Pills rendered above the textarea. Owned by the parent so it
   *  can attach lifecycle (uploading / ready / failed) state. */
  pills?: ReactNode;
  /** Flips the border into the pulsing-gradient state. */
  uploading?: boolean;
}

/**
 * Presentational composer surface — gradient border + textarea + lower
 * row with leftSlot and action buttons. State + business logic live in
 * the variants (NewSessionComposer, TurnComposer) so each is small.
 */
export const ComposerShell = forwardRef<HTMLTextAreaElement, Props>(
  function ComposerShell(
    {
      value,
      onChange,
      onSubmit,
      leftSlot,
      rightExtras,
      busy = false,
      disabled = false,
      canSend = false,
      placeholder = "Start something new...",
      showAttachButton = true,
      hint,
      error,
      onStop,
      onFiles,
      pills,
      uploading = false,
    },
    ref,
  ) {
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const textareaRef = (ref ??
      internalRef) as React.MutableRefObject<HTMLTextAreaElement | null>;

    // X1A-98 drag/drop visual state — local to the shell. The grey
    // 64x64 upload icon overlay appears only while the user is
    // dragging over the composer; the actual upload work is owned by
    // the parent via onFiles. dragDepth tracks nested dragenter/leave
    // pairs to avoid flicker when the cursor moves over child elements.
    const [dragDepth, setDragDepth] = useState(0);
    const dragActive = dragDepth > 0 && !!onFiles;

    const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
      if (!onFiles) return;
      // Only react to file drags — text/range selections etc. should
      // pass through to the textarea unmodified.
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      setDragDepth((d) => d + 1);
    };
    const onDragOver = (e: DragEvent<HTMLDivElement>) => {
      if (!onFiles) return;
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
      if (!onFiles) return;
      e.preventDefault();
      setDragDepth((d) => Math.max(0, d - 1));
    };
    const onDrop = (e: DragEvent<HTMLDivElement>) => {
      if (!onFiles) return;
      e.preventDefault();
      setDragDepth(0);
      if (e.dataTransfer.files.length > 0) {
        onFiles(e.dataTransfer.files);
      }
    };

    const handleSubmit = (e: FormEvent) => {
      e.preventDefault();
      if (!canSend) return;
      onSubmit();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (canSend) onSubmit();
      }
    };

    const borderClass =
      "composer-border" +
      (uploading ? " composer-border--uploading" : "") +
      (dragActive ? " composer-border--drag-over" : "");

    return (
      <form
        onSubmit={handleSubmit}
        className="w-full"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Border palette mirrors the sidebar's rail-gradient blobs:
            pastel blue → lavender → peach → pink. 2px to read as a
            distinct halo rather than a hairline. The .composer-border
            utility sources its gradient from --composer-border so
            light and dark modes each pick their own saturation. */}
        <div
          className={`${borderClass} relative rounded-2xl p-[2px] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_10px_28px_-14px_rgba(0,0,0,0.30)]`}
        >
          <div className="relative rounded-[14px] bg-surface px-4 pt-3 pb-2">
            {pills && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {pills}
              </div>
            )}
            {/* Pure-CSS autosize. The grid row tracks the hidden mirror
                <span> whose content matches the textarea's value plus a
                trailing space (so a fresh newline still extends the row).
                Avoids the JS `scrollHeight` read on every keystroke,
                which forced a full-document reflow and was the
                dominant per-keystroke cost on iPad with a long
                unvirtualized event timeline. Cap at ~6 rows via
                `max-h-[168px]` + `overflow-y-auto` on the grid. */}
            <div
              className="composer-autosize grid max-h-[168px] overflow-y-auto"
              data-testid="composer-autosize"
            >
              <span
                aria-hidden
                className="invisible whitespace-pre-wrap break-words text-[15px] leading-6 [grid-area:1/1/2/2]"
              >
                {value + " "}
              </span>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={disabled}
                placeholder={placeholder}
                className="block w-full resize-none overflow-hidden bg-transparent text-[15px] leading-6 text-fg placeholder:text-fg-faint focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 [grid-area:1/1/2/2]"
              />
            </div>

            {/* Drop-target overlay: a centered 64x64 grey upload icon
                appears whenever a file is being dragged over the
                composer. pointer-events-none so the drag events still
                land on the form. */}
            {dragActive && (
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[14px] bg-surface/80 backdrop-blur-[1px]"
                data-testid="composer-drop-overlay"
              >
                <div className="grid size-16 place-items-center rounded-2xl border-2 border-dashed border-fg-faint/60 text-fg-muted">
                  <Upload size={28} strokeWidth={2} />
                </div>
              </div>
            )}

            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">{leftSlot}</div>

              <div className="flex items-center gap-1.5">
                {showAttachButton && (
                  <button
                    type="button"
                    aria-label="Attach (coming soon)"
                    disabled
                    className="grid h-8 w-8 place-items-center rounded-full bg-bg-muted/60 text-fg-muted opacity-60 cursor-not-allowed"
                  >
                    <Plus size={16} strokeWidth={2.25} />
                  </button>
                )}
                {rightExtras}
                {busy && onStop && (
                  <button
                    type="button"
                    aria-label="Pause session"
                    title="Pause session"
                    onClick={onStop}
                    className="grid h-8 w-8 place-items-center rounded-full bg-accent text-accent-fg transition hover:opacity-90"
                  >
                    <Pause size={14} strokeWidth={2.5} fill="currentColor" />
                  </button>
                )}
                <button
                  type="submit"
                  aria-label="Send"
                  disabled={!canSend}
                  className={
                    "grid h-8 w-8 place-items-center rounded-full transition " +
                    (canSend
                      ? "bg-fg text-bg hover:opacity-90"
                      : "bg-bg-muted text-fg-faint cursor-not-allowed")
                  }
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-2 px-1 text-[13px] text-red-500">{error}</div>
        )}
        {hint !== null && (
          <div className="mt-1.5 px-1 text-[11px] text-fg-faint/70">
            {hint ?? "⌘/Ctrl+Enter to send · Enter for newline"}
          </div>
        )}
      </form>
    );
  },
);
