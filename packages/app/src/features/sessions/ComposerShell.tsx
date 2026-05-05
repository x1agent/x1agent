import {
  forwardRef,
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Plus, Pause, ArrowUp } from "lucide-react";

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
    },
    ref,
  ) {
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const textareaRef = (ref ??
      internalRef) as React.MutableRefObject<HTMLTextAreaElement | null>;

    // Autosize up to ~6 rows.
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 168) + "px";
    }, [value, textareaRef]);

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

    return (
      <form onSubmit={handleSubmit} className="w-full">
        {/* Border palette mirrors the sidebar's rail-gradient blobs:
            pastel blue → lavender → peach → pink. 2px to read as a
            distinct halo rather than a hairline. The .composer-border
            utility sources its gradient from --composer-border so
            light and dark modes each pick their own saturation. */}
        <div className="composer-border relative rounded-2xl p-[2px] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_10px_28px_-14px_rgba(0,0,0,0.30)]">
          <div className="rounded-[14px] bg-surface px-4 pt-3 pb-2">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={disabled}
              placeholder={placeholder}
              className="block w-full resize-none bg-transparent text-[15px] leading-6 text-fg placeholder:text-fg-faint focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />

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
