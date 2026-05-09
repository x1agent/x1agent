import { useEffect, useRef } from "react";
import type { SessionEventDTO } from "@x1agent/shared";
import { EventCard } from "./EventCard";
import { latestPublicEvent } from "./eventClassification";

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
 * Decorative full-width divider line used to frame the "latest public
 * event" widget in default mode. Pure styling — no semantics; the
 * accessible name is on the event card itself.
 */
function TimelineDivider() {
  return (
    <div
      role="presentation"
      data-testid="timeline-divider"
      className="my-2 h-px w-full bg-border-soft"
    />
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

  // Default (compact) mode: collapse the entire stream into a single
  // "what is the agent doing right now" widget framed with dividers.
  // The previous public event is REPLACED by the latest one, so the
  // operator sees a calm, current view instead of a scrolling firehose
  // of ToolSearch + internal tool-call entries. Toggling Verbose
  // reveals the full event stream below.
  if (!verbose) {
    const latest = latestPublicEvent(events);
    return (
      <div
        className="flex-1 overflow-y-auto"
        data-testid="event-stream-compact"
      >
        <div className="mx-auto max-w-3xl px-4 py-6">
          <TimelineDivider />
          {latest ? (
            <EventCard
              key={`${latest.session_id}-${latest.seq}`}
              event={latest}
              verbose={false}
              onRespond={onRespond}
              workspaceSlug={workspaceSlug}
              agentId={agentId}
              sessionId={sessionId}
            />
          ) : (
            <div className="py-2 text-center text-xs text-fg-faint">
              Waiting for the agent to start…
            </div>
          )}
          <TimelineDivider />
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
