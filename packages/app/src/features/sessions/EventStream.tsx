import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown, ChevronDown, ChevronRight } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { EventCard } from "./EventCard";
import { compactTimeline, type CompactItem } from "./eventClassification";

interface Props {
  events: SessionEventDTO[];
  verbose?: boolean;
  onRespond?: (text: string, requestId: string) => void;
  workspaceSlug: string;
  /** The agent running this session — used as the subject of request_grant approvals. */
  agentId?: string;
  /** The session id — used as the session_id when an approved grant has scope='session'. */
  sessionId: string;
  /**
   * Pre-computed compact rows from the store. Optional — if absent,
   * the component derives them from `events` on the fly. Production
   * passes the cached value from `useSessionDetailStore` so we don't
   * re-group on every render; tests can omit it and exercise the
   * inline path.
   */
  compactItems?: CompactItem[];
  /**
   * X1A-104 — bottom-of-timeline slot rendered after the last event
   * but before the scroll anchor. Used by SessionRoot to mount the
   * transient typing indicator without restructuring the timeline.
   * Kept generic (ReactNode) so it stays a clean mount point rather
   * than a one-off indicator hook.
   */
  tailSlot?: React.ReactNode;
}

/**
 * Collapsible pill that stands in for a run of consecutive
 * `agent.tool_call` events. One click expands to the underlying
 * ToolCallCards. Single-call groups skip the pill entirely so the
 * UI doesn't add a click for no reason.
 */
function ToolGroupPill({
  events,
  workspaceSlug,
  agentId,
  sessionId,
}: {
  events: readonly SessionEventDTO[];
  workspaceSlug: string;
  agentId?: string;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  if (events.length === 1) {
    const e = events[0]!;
    return (
      <EventCard
        event={e}
        verbose={false}
        workspaceSlug={workspaceSlug}
        agentId={agentId}
        sessionId={sessionId}
      />
    );
  }
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-soft px-2 py-1 text-[11px] text-fg-muted hover:border-border-strong hover:text-fg"
        aria-expanded={open}
      >
        <Icon className="size-3" />
        <span>{events.length} tool calls</span>
      </button>
      {open && (
        <div className="mt-1 ml-3 space-y-1 border-l border-border-soft pl-2">
          {events.map((e) => (
            <EventCard
              key={`${e.session_id}-${e.seq}`}
              event={e}
              verbose={false}
              workspaceSlug={workspaceSlug}
              agentId={agentId}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Distance from the bottom (in px) within which we still consider the
// user "at the bottom" and follow new events. Anything farther up and
// the scroll position is left alone — the user is reading something.
const STICK_TO_BOTTOM_PX = 120;

export function EventStream({
  events,
  verbose,
  onRespond,
  workspaceSlug,
  agentId,
  sessionId,
  compactItems,
  tailSlot,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Ref + state mirror each other. The ref is read in the events-append
  // effect (no re-render), the state drives the Jump-to-latest button.
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const initialJumpDoneRef = useRef(false);

  const isNearBottom = useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
  }, []);

  const onScroll = useCallback(() => {
    const near = isNearBottom();
    stickRef.current = near;
    setAtBottom((prev) => (prev === near ? prev : near));
  }, [isNearBottom]);

  const jumpToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  // Open at bottom (instant — no smooth-scroll animation on mount).
  // useLayoutEffect so the jump happens before the browser paints the
  // first frame, avoiding the user briefly seeing the top of a long
  // timeline.
  useLayoutEffect(() => {
    if (initialJumpDoneRef.current) return;
    if (events.length === 0) return;
    jumpToBottom(false);
    initialJumpDoneRef.current = true;
  }, [events.length, jumpToBottom]);

  // Follow new events ONLY if the user is already near the bottom.
  // This is the fix for the screen-grab: previously this effect always
  // scrollIntoView'd, yanking the viewport on every incoming message.
  useEffect(() => {
    if (!initialJumpDoneRef.current) return;
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length]);

  // Fall back to the inline grouper when the parent didn't supply
  // pre-computed rows (tests, isolated previews). useMemo here keeps
  // the items array reference stable across unrelated re-renders so
  // a future React.memo on EventCard can actually skip work.
  const fallbackItems = useMemo(
    () => (compactItems === undefined ? compactTimeline(events) : null),
    [events, compactItems],
  );

  if (events.length === 0) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center p-10 text-sm text-fg-faint"
        data-testid="event-stream-empty"
      >
        <div>Waiting for events…</div>
        {tailSlot}
      </div>
    );
  }

  let inner: React.ReactNode;
  if (!verbose) {
    const items: CompactItem[] = compactItems ?? fallbackItems ?? [];
    inner = (
      <div className="mx-auto max-w-3xl space-y-1 px-4 py-6">
        {items.length === 0 ? (
          <div className="py-2 text-center text-xs text-fg-faint">
            Waiting for the agent to start…
          </div>
        ) : (
          items.map((it) => {
            if (it.kind === "event") {
              return (
                <EventCard
                  key={it.key}
                  event={it.event}
                  verbose={false}
                  onRespond={onRespond}
                  workspaceSlug={workspaceSlug}
                  agentId={agentId}
                  sessionId={sessionId}
                />
              );
            }
            if (it.kind === "status") {
              // Stable key across the run so React mutates the same
              // node in place when a newer status arrives — no flash,
              // no scroll bump.
              return (
                <EventCard
                  key={`status-${it.key}`}
                  event={it.latest}
                  verbose={false}
                  workspaceSlug={workspaceSlug}
                  agentId={agentId}
                  sessionId={sessionId}
                />
              );
            }
            return (
              <ToolGroupPill
                key={`tools-${it.key}`}
                events={it.events}
                workspaceSlug={workspaceSlug}
                agentId={agentId}
                sessionId={sessionId}
              />
            );
          })
        )}
      </div>
    );
  } else {
    inner = (
      <div className="mx-auto max-w-3xl px-4 py-6">
        {events.map((e) => (
          <EventCard
            key={`${e.session_id}-${e.seq}`}
            event={e}
            verbose={verbose}
            onRespond={onRespond}
            workspaceSlug={workspaceSlug}
            agentId={agentId}
            sessionId={sessionId}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
        data-testid={verbose ? "event-stream-verbose" : "event-stream-compact"}
      >
        {inner}
        {tailSlot}
        <div ref={bottomRef} />
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => jumpToBottom(true)}
          data-testid="scroll-to-latest"
          aria-label="Jump to latest"
          className="absolute bottom-4 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-bg-elevated px-3 py-1.5 text-xs text-fg shadow-md hover:bg-bg-elevated/70"
        >
          <ArrowDown className="size-3.5" />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  );
}
