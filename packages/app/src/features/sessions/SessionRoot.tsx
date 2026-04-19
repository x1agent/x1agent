import { useEffect, useRef, useState } from "react";
import { connect, StringCodec, type NatsConnection } from "nats.ws";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { useAuthStore } from "../../stores/authStore";
import { useSessionDetailStore } from "../../stores/sessionDetailStore";
import type { SessionEventDTO, SessionStatus } from "@x1agent/shared";
import { EventStream } from "./EventStream";
import { MessageInput } from "./MessageInput";

interface Props {
  workspaceSlug: string;
  sessionId: string;
}

const NATS_WS_URL =
  typeof window !== "undefined"
    ? ((import.meta as unknown as { env?: { PUBLIC_NATS_WS_URL?: string } })
        .env?.PUBLIC_NATS_WS_URL ?? "ws://localhost:8080")
    : "ws://localhost:8080";

const STATUS_COLOR: Record<SessionStatus, string> = {
  pending: "text-zinc-400",
  running: "text-blue-400",
  complete: "text-emerald-400",
  failed: "text-red-400",
};

export function SessionRoot({ workspaceSlug, sessionId }: Props) {
  const { status: authStatus, fetchMe } = useAuthStore();
  const {
    sessionsById,
    agentsBySession,
    eventsBySession,
    errorBySession,
    loadInitial,
    appendEvent,
    setError,
  } = useSessionDetailStore();

  const [verbose, setVerbose] = useState(false);
  const ncRef = useRef<NatsConnection | null>(null);
  const seqRef = useRef(0);

  const session = sessionsById[sessionId];
  const agent = agentsBySession[sessionId];
  const events = eventsBySession[sessionId] ?? [];
  const error = errorBySession[sessionId];

  useEffect(() => {
    if (authStatus === "idle") fetchMe();
  }, [authStatus, fetchMe]);

  useEffect(() => {
    if (authStatus === "anonymous" && typeof window !== "undefined") {
      window.location.href = "/";
    }
  }, [authStatus]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await loadInitial(workspaceSlug, sessionId);
      if (cancelled) return;
      try {
        const nc = await connect({ servers: NATS_WS_URL });
        if (cancelled) {
          await nc.close();
          return;
        }
        ncRef.current = nc;
        const sc = StringCodec();
        const sub = nc.subscribe(`x1.session.${sessionId}.events`);

        (async () => {
          for await (const m of sub) {
            if (cancelled) break;
            try {
              const msg = JSON.parse(sc.decode(m.data)) as {
                session_id: string;
                sequence: number;
                type: string;
                payload: unknown;
                timestamp: string;
              };
              const ev: SessionEventDTO = {
                id: `nats-${msg.session_id}-${msg.sequence}`,
                session_id: msg.session_id,
                seq: msg.sequence,
                type: msg.type,
                payload: msg.payload,
                timestamp: msg.timestamp,
              };
              appendEvent(sessionId, ev);
            } catch {
              // drop malformed
            }
          }
        })().catch(() => {});

        // Presence heartbeat every 20s so the agent's idle timer stays
        // warm while someone is watching.
        const heartbeat = () => {
          try {
            nc.publish(
              `x1.session.${sessionId}.presence`,
              sc.encode(JSON.stringify({ at: new Date().toISOString() })),
            );
          } catch {
            // ignore; next tick will retry
          }
        };
        heartbeat();
        const hbInterval = setInterval(heartbeat, 20_000);
        (nc as NatsConnection & { __hbCleanup?: () => void }).__hbCleanup =
          () => clearInterval(hbInterval);
      } catch (err) {
        setError(sessionId, `NATS connect failed: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      const nc = ncRef.current as
        | (NatsConnection & { __hbCleanup?: () => void })
        | null;
      if (nc) {
        nc.__hbCleanup?.();
        void nc.close();
      }
      ncRef.current = null;
    };
  }, [workspaceSlug, sessionId, loadInitial, appendEvent, setError]);

  const sendMessage = (text: string, requestId?: string) => {
    const nc = ncRef.current;
    if (!nc) return;
    const sc = StringCodec();
    const payload: Record<string, unknown> = { text };
    if (requestId) {
      payload["request_id"] = requestId;
      payload["answer"] = text;
    }
    const envelope = {
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      sequence: seqRef.current++,
      type: requestId ? "user.input_response" : "user.message",
      payload,
    };
    nc.publish(
      `x1.session.${sessionId}.input`,
      sc.encode(JSON.stringify(envelope)),
    );
    // Local echo so the user sees their message immediately.
    appendEvent(sessionId, {
      id: `local-${envelope.sequence}`,
      session_id: sessionId,
      seq: 1_000_000_000 + envelope.sequence,
      type: "user.message",
      payload: { text },
      timestamp: envelope.timestamp,
    });
  };

  const disabled =
    !session ||
    session.status === "complete" ||
    session.status === "failed";

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        ...(agent
          ? [
              {
                label: agent.name,
                href: `/workspaces/${workspaceSlug}/agents/${agent.slug}`,
              },
            ]
          : []),
        { label: sessionId.slice(0, 8) },
      ]}
    >
      <div className="flex h-full min-h-[calc(100svh-56px)] flex-col">
        <div className="flex items-center justify-end gap-3 border-b border-zinc-900 px-4 py-2 text-xs">
          {session && (
            <span className={STATUS_COLOR[session.status]}>
              {session.status}
            </span>
          )}
          <span className="text-zinc-600">{events.length} events</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVerbose((v) => !v)}
            className="h-7 text-[11px] text-zinc-400"
          >
            {verbose ? "Compact" : "Verbose"}
          </Button>
        </div>

        {error && (
          <div className="border-b border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <EventStream
          events={events}
          verbose={verbose}
          onRespond={sendMessage}
        />

        <MessageInput
          onSend={sendMessage}
          disabled={disabled}
          placeholder={
            disabled
              ? session?.status === "complete"
                ? "Session ended."
                : session?.status === "failed"
                  ? "Session failed."
                  : "Connecting…"
              : "Send a message to the agent…"
          }
        />
      </div>
    </AppShell>
  );
}
