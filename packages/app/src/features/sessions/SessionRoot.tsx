import { useEffect, useRef, useState } from "react";
import { connect, StringCodec, type NatsConnection } from "nats.ws";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { useAuthStore } from "../../stores/authStore";
import { useSessionDetailStore } from "../../stores/sessionDetailStore";
import { useSessionsStore } from "../../stores/sessionsStore";
import type { SessionEventDTO, SessionStatus } from "@x1agent/shared";
import { EventStream } from "./EventStream";
import { MessageInput } from "./MessageInput";
import { PENDING_PROMPT_KEY_PREFIX } from "./RecentRunsSection";
import { Badge, type BadgeVariant } from "../../components/ui/badge";

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

const STATUS_VARIANT: Record<SessionStatus, BadgeVariant> = {
  pending: "secondary",
  running: "info",
  complete: "success",
  failed: "danger",
};

export function SessionRoot({ workspaceSlug, sessionId }: Props) {
  const { status: authStatus, fetchMe } = useAuthStore();
  const {
    sessionsById,
    agentsBySession,
    parentBySession,
    childrenBySession,
    eventsBySession,
    errorBySession,
    loadInitial,
    appendEvent,
    setError,
  } = useSessionDetailStore();

  const [verbose, setVerbose] = useState(false);
  const [resuming, setResuming] = useState(false);
  const ncRef = useRef<NatsConnection | null>(null);
  const seqRef = useRef(0);
  // If the user entered a prompt on the "Run" card before navigating,
  // RecentRunsSection stashed it in sessionStorage. Read it once so a
  // later clear (from the auto-send effect) doesn't race us.
  const pendingPromptRef = useRef<string | null>(
    typeof window !== "undefined"
      ? window.sessionStorage.getItem(
          `${PENDING_PROMPT_KEY_PREFIX}${sessionId}`,
        )
      : null,
  );
  const pendingPromptSentRef = useRef(false);
  const resumeAction = useSessionsStore((s) => s.resume);

  const onResume = async () => {
    setResuming(true);
    try {
      const created = await resumeAction(workspaceSlug, sessionId);
      window.location.href = `/workspaces/${workspaceSlug}/sessions/${created.id}`;
    } catch (err) {
      setError(sessionId, (err as Error).message);
      setResuming(false);
    }
  };

  const session = sessionsById[sessionId];
  const agent = agentsBySession[sessionId];
  const parent = parentBySession[sessionId] ?? null;
  const children = childrenBySession[sessionId] ?? [];
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

        // Presence / stay-alive: the agent's idle timer starts counting
        // down as soon as the conversation is quiet. To keep a session
        // warm while someone is watching but not actively typing, the
        // browser publishes to `x1.session.{id}.presence`; the sidecar
        // forwards each ping to the agent's /keepalive endpoint, which
        // resets the idle timer.
        //
        // Cadence:
        //   - Immediate kickoff ping on subscribe
        //   - Every 20s thereafter
        //   - Extra ping on tab refocus (setInterval can stall or skip
        //     in backgrounded tabs, so re-ping the moment the user
        //     comes back — matches the upstream pattern)
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
        const onVisibilityChange = () => {
          if (document.visibilityState === "visible") heartbeat();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        (nc as NatsConnection & { __hbCleanup?: () => void }).__hbCleanup =
          () => {
            clearInterval(hbInterval);
            document.removeEventListener(
              "visibilitychange",
              onVisibilityChange,
            );
          };
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
    const basePayload: Record<string, unknown> = { text };
    const payload: Record<string, unknown> = { ...basePayload };
    if (requestId) {
      payload["request_id"] = requestId;
      payload["answer"] = text;
    }
    // The agent now emits a user.message (or user.input_response) to
    // its SSE stream on inject, which the sidecar publishes to NATS
    // and the api persists to session_events. The browser picks up
    // that same event via its NATS subscription — so we do NOT add a
    // local echo here. The round trip is one hop through the pod and
    // costs ~50–200ms; in exchange the event is durable and survives
    // page refresh.
    const seq = seqRef.current++;
    const envelope = {
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      sequence: seq,
      type: requestId ? "user.input_response" : "user.message",
      payload,
    };
    nc.publish(
      `x1.session.${sessionId}.input`,
      sc.encode(JSON.stringify(envelope)),
    );
  };

  // Auto-send a pending prompt once the agent is actually up. We wait
  // for the `session.started` event rather than the session row's
  // status transition because `.started` is published by the agent
  // itself — seeing it means the sidecar's event bridge AND the agent
  // process are both live, which also means the sidecar has
  // subscribed to `.input` and won't drop our publish. NATS core is
  // at-most-once, so publishing earlier would be a silent loss.
  useEffect(() => {
    const pending = pendingPromptRef.current;
    if (!pending || pendingPromptSentRef.current) return;
    if (!ncRef.current) return;
    const hasStarted = events.some((e) => e.type === "session.started");
    if (!hasStarted) return;
    pendingPromptSentRef.current = true;
    sendMessage(pending);
    try {
      window.sessionStorage.removeItem(
        `${PENDING_PROMPT_KEY_PREFIX}${sessionId}`,
      );
    } catch {
      // storage may be disabled; nothing else to clean up.
    }
  }, [events, sessionId]);

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
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-900 px-4 py-2 text-xs">
          {parent && (
            <a
              href={`/workspaces/${workspaceSlug}/sessions/${parent.session_id}`}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
              title={`spawned by session ${parent.session_id.slice(0, 8)}`}
            >
              <span className="text-zinc-500">from</span>
              <span>{parent.agent.name}</span>
            </a>
          )}
          {session?.resumed_from && (
            <a
              href={`/workspaces/${workspaceSlug}/sessions/${session.resumed_from}`}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
              title={`continues session ${session.resumed_from.slice(0, 8)}`}
            >
              <span className="text-zinc-500">resumed from</span>
              <span className="font-mono">
                {session.resumed_from.slice(0, 8)}
              </span>
            </a>
          )}
          {children.length > 0 && (
            <span className="text-zinc-500">
              {children.length}{" "}
              {children.length === 1 ? "child" : "children"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            {session && (
              <span className={STATUS_COLOR[session.status]}>
                {session.status}
              </span>
            )}
            <span className="text-zinc-600">{events.length} events</span>
            {session &&
              (session.status === "complete" ||
                session.status === "failed") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onResume}
                  disabled={resuming}
                  className="h-7 text-[11px]"
                >
                  {resuming ? "Resuming…" : "Resume"}
                </Button>
              )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVerbose((v) => !v)}
              className="h-7 text-[11px] text-zinc-400"
            >
              {verbose ? "Compact" : "Verbose"}
            </Button>
          </div>
        </div>

        {children.length > 0 && (
          <div className="border-b border-zinc-900 bg-zinc-950 px-4 py-2">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
              Children
            </div>
            <div className="flex flex-wrap gap-2">
              {children.map((ch) => (
                <a
                  key={ch.id}
                  href={`/workspaces/${workspaceSlug}/sessions/${ch.id}`}
                  className="inline-flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1 text-xs hover:border-zinc-700 hover:bg-zinc-900/60"
                >
                  <Badge variant={STATUS_VARIANT[ch.status]}>
                    {ch.status}
                  </Badge>
                  <span className="text-zinc-200">{ch.agent.name}</span>
                  <span className="text-zinc-600">
                    {new Date(ch.triggered_at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="border-b border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <EventStream
          events={events}
          verbose={verbose}
          onRespond={sendMessage}
          workspaceSlug={workspaceSlug}
          agentId={agent?.id}
          sessionId={sessionId}
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
