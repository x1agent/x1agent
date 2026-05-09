import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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

export function EventStream({
  events,
  verbose,
  onRespond,
  workspaceSlug,
  agentId,
  sessionId,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-sm text-fg-faint">
        Waiting for events…
      </div>
    );
  }

  // Default (compact) mode: chronological view with the noisy bits
  // collapsed. Status events fold to a single mutating line per run;
  // consecutive tool calls collapse to a "[ N tool calls ]" pill the
  // operator can expand. Everything else (text, shares, prompts,
  // session banners) renders inline so the conversational arc stays
  // intact. Verbose mode (below) keeps showing every event.
  if (!verbose) {
    const items: CompactItem[] = compactTimeline(events);
    return (
      <div
        className="flex-1 overflow-y-auto"
        data-testid="event-stream-compact"
      >
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
        <div ref={bottomRef} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto" data-testid="event-stream-verbose">
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
      <div ref={bottomRef} />
    </div>
  );
}
