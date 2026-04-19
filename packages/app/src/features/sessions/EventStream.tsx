import { useEffect, useRef } from "react";
import type { SessionEventDTO } from "@x1agent/shared";
import { EventCard } from "./EventCard";

interface Props {
  events: SessionEventDTO[];
  verbose?: boolean;
  onRespond?: (text: string, requestId: string) => void;
}

export function EventStream({ events, verbose, onRespond }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-sm text-zinc-500">
        Waiting for events…
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="divide-y divide-zinc-900/50">
        {events.map((e) => (
          <EventCard
            key={`${e.session_id}-${e.seq}`}
            event={e}
            verbose={verbose}
            onRespond={onRespond}
          />
        ))}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
