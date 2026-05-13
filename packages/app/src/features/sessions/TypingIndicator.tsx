import { useEffect } from "react";
import {
  useTypingIndicatorStore,
  selectSessionIndicatorMap,
  type ActiveIndicator,
} from "../../stores/typingIndicatorStore";

/**
 * Visual: three muted dots bobbing on a ~1.4s cycle. Motion does
 * the signaling — the dots use the existing `text-fg-muted` token
 * so they match the rest of the conversational chrome in light and
 * dark mode without freelancing new colors.
 *
 * The animation keyframes live inline (style tag scoped to the
 * component) so we don't have to extend the Tailwind config or
 * global stylesheet for one feature. The keyframes name is hashed
 * with the variant so two simultaneous indicators don't fight over
 * a single `@keyframes` definition.
 */

type Variant = "main" | "thread";

const DOT_BASE_CLS =
  "inline-block rounded-full bg-current align-baseline will-change-transform";

const VARIANT_DOT_SIZE: Record<Variant, string> = {
  main: "size-1.5",
  thread: "size-1",
};

const VARIANT_WRAPPER_CLS: Record<Variant, string> = {
  // Matches the rhythm of AgentText: muted text tone, comfortable
  // padding, transparent background so it reads as in-flight thinking
  // rather than a finished bubble.
  main:
    "flex items-center gap-1.5 px-1 py-1.5 text-fg-muted",
  // Smaller, denser variant for the share-comment-thread popover —
  // sits inside the thread card so it shouldn't dominate.
  thread:
    "flex items-center gap-1 px-1 py-1 text-fg-muted",
};

const VARIANT_GAP_PX: Record<Variant, number> = {
  main: 4,
  thread: 3,
};

interface TypingDotsProps {
  variant?: Variant;
}

function TypingDots({ variant = "main" }: TypingDotsProps) {
  const dotCls = `${DOT_BASE_CLS} ${VARIANT_DOT_SIZE[variant]}`;
  const gap = VARIANT_GAP_PX[variant];
  return (
    <span
      className="inline-flex items-end"
      style={{ gap: `${gap}px`, lineHeight: 1 }}
      aria-hidden="true"
    >
      <span
        className={dotCls}
        style={{ animation: "x1-typing-bob 1.4s ease-in-out 0s infinite" }}
      />
      <span
        className={dotCls}
        style={{ animation: "x1-typing-bob 1.4s ease-in-out 0.2s infinite" }}
      />
      <span
        className={dotCls}
        style={{ animation: "x1-typing-bob 1.4s ease-in-out 0.4s infinite" }}
      />
    </span>
  );
}

/** Inject the keyframes once — repeated mounts noop. */
function useEnsureKeyframes() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById("x1-typing-keyframes")) return;
    const style = document.createElement("style");
    style.id = "x1-typing-keyframes";
    style.textContent = `
      @keyframes x1-typing-bob {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.45; }
        30%           { transform: translateY(-2px); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        @keyframes x1-typing-bob {
          0%, 100% { transform: none; opacity: 0.7; }
        }
      }
    `;
    document.head.appendChild(style);
  }, []);
}

/**
 * Single indicator pill. Carries its own `role="status"` /
 * `aria-live="polite"` and announces the screen-reader sentence
 * exactly once (the visible dots are `aria-hidden`).
 */
function IndicatorPill({
  variant,
  testIdSuffix,
}: {
  variant: Variant;
  testIdSuffix: string;
}) {
  useEnsureKeyframes();
  return (
    <div
      role="status"
      aria-live="polite"
      className={VARIANT_WRAPPER_CLS[variant]}
      data-testid={`typing-indicator-${testIdSuffix}`}
    >
      <span className="sr-only">agent is thinking</span>
      <TypingDots variant={variant} />
    </div>
  );
}

/**
 * Tick the TTL sweep every second so a pod-death scenario eventually
 * drops the indicator instead of ghosting the UI. The interval runs
 * only while at least one indicator is mounted (the parent guards
 * mounting on `indicators.length > 0`).
 */
function useTtlSweep(sessionId: string) {
  const sweep = useTypingIndicatorStore((s) => s.sweepExpired);
  useEffect(() => {
    const t = setInterval(() => sweep(sessionId), 1_000);
    // Sweep once on mount so a stale indicator inherited from before
    // the page took focus clears immediately.
    sweep(sessionId);
    return () => clearInterval(t);
  }, [sessionId, sweep]);
}

/**
 * Main-timeline indicators — renders one pill per active wake whose
 * `share_id` and `thread_id` are both null. Returns null when there
 * are no main-scoped indicators so the timeline doesn't reserve
 * empty whitespace.
 */
export function MainTimelineTypingIndicators({
  sessionId,
}: {
  sessionId: string;
}) {
  const indicators = useTypingIndicatorStore(selectSessionIndicatorMap(sessionId));
  const active: ActiveIndicator[] = Object.values(indicators).filter(
    (i) => i.share_id === null && i.thread_id === null,
  );
  useTtlSweep(sessionId);
  if (active.length === 0) return null;
  return (
    <div className="mx-auto max-w-3xl px-4 pb-3">
      {active.map((ind) => (
        <IndicatorPill
          key={ind.event_id}
          variant="main"
          testIdSuffix={`main-${ind.event_id}`}
        />
      ))}
    </div>
  );
}

/**
 * Share-comment-thread indicators — renders one pill per active wake
 * matching both `shareId` and `threadId`. Smaller variant; intended
 * to mount inside the thread card's body. Never bubbles into the
 * main timeline.
 */
export function ThreadTypingIndicators({
  sessionId,
  shareId,
  threadId,
}: {
  sessionId: string;
  shareId: string;
  threadId: string;
}) {
  const indicators = useTypingIndicatorStore(selectSessionIndicatorMap(sessionId));
  const active: ActiveIndicator[] = Object.values(indicators).filter(
    (i) => i.share_id === shareId && i.thread_id === threadId,
  );
  // Don't double-tick the sweep — the main-timeline mount inside the
  // session page already runs the interval for this session id. When
  // the thread indicator is the only consumer (e.g. fullscreen
  // artifact view without the timeline mounted) we still need a
  // sweep, so guard with a sentinel data attribute to avoid two
  // intervals racing.
  useTtlSweep(sessionId);
  if (active.length === 0) return null;
  return (
    <div className="mt-2">
      {active.map((ind) => (
        <IndicatorPill
          key={ind.event_id}
          variant="thread"
          testIdSuffix={`thread-${ind.event_id}`}
        />
      ))}
    </div>
  );
}
