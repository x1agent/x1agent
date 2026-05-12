import { useEffect, useRef, useState } from "react";
import { connect, StringCodec, type NatsConnection } from "nats.ws";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { useAuthStore } from "../../stores/authStore";
import { useSessionDetailStore } from "../../stores/sessionDetailStore";
import { useSessionsStore } from "../../stores/sessionsStore";
import type { SessionEventDTO, SessionStatus } from "@x1agent/shared";
import { EventStream } from "./EventStream";
import { TurnComposer } from "./TurnComposer";
import { ShareSessionPanel } from "./ShareSessionPanel";
import { ArtifactPanel } from "./ArtifactPanel";
import { useArtifactPanelStore } from "../../stores/artifactPanelStore";
import { useShareCommentsStore } from "../../stores/shareCommentsStore";
import type { AgentSharePayload } from "./ShareCard";
import type { ShareCommentDTO } from "@x1agent/shared";
import { ChildWorkersCounter } from "./ChildWorkersCounter";
import { SessionCostBlock } from "./SessionCostBlock";
import { SessionTitle } from "./SessionTitle";
import { Share2 } from "lucide-react";
import { usePendingPromptStore } from "../../stores/pendingPromptStore";

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
  pending: "text-fg-muted",
  running: "text-blue-400",
  complete: "text-emerald-400",
  failed: "text-red-400",
};

export function SessionRoot({ workspaceSlug, sessionId }: Props) {
  const { status: authStatus, fetchMe } = useAuthStore();
  const {
    sessionsById,
    agentsBySession,
    parentBySession,
    eventsBySession,
    errorBySession,
    loadInitial,
    appendEvent,
    setError,
    setSession,
  } = useSessionDetailStore();

  const [verbose, setVerbose] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const ncRef = useRef<NatsConnection | null>(null);
  const seqRef = useRef(0);
  const takePendingPrompt = usePendingPromptStore((s) => s.take);
  const pendingPromptSentRef = useRef(false);
  const resumeAction = useSessionsStore((s) => s.resume);
  const cancelAction = useSessionsStore((s) => s.cancel);

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

  const onPause = async () => {
    if (!agent) return;
    try {
      const cancelled = await cancelAction(workspaceSlug, agent.id, sessionId);
      // Reflect the new status in the detail store so the composer
      // disables, the status pill flips, and the Resume affordance
      // appears without waiting for a NATS event the pod may not get
      // around to publishing before the user looks.
      setSession(sessionId, cancelled);
    } catch (err) {
      setError(sessionId, (err as Error).message);
    }
  };

  const session = sessionsById[sessionId];
  const agent = agentsBySession[sessionId];
  const parent = parentBySession[sessionId] ?? null;
  const events = eventsBySession[sessionId] ?? [];
  const error = errorBySession[sessionId];
  // Selector returns the cached array reference; `?? []` lives outside
  // the selector per the project's zustand foot-gun rule (a default
  // inside the selector would mint a new `[]` on every render and
  // tank `React.memo` further down the tree).
  const compactItems =
    useSessionDetailStore((s) => s.compactItemsBySession[sessionId]) ?? [];

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

        // Live comment updates — subscribe to the platform-wide
        // share-comment NATS subjects so the comments sidebar reflects
        // new threads/replies/resolves without a refresh. The subjects
        // are cluster-wide, not per-session, so a single subscription
        // covers any share the user is viewing. The store's
        // applyServerEvent is idempotent on (thread_id, seq) so this
        // is safe even if a comment also arrives via the local POST
        // (optimistic append).
        const commentAddedSub = nc.subscribe("agent.share_comment_added");
        (async () => {
          for await (const m of commentAddedSub) {
            if (cancelled) break;
            try {
              const p = JSON.parse(sc.decode(m.data)) as {
                share_id?: string;
                thread_id?: string;
                comment_id?: string;
                actor_user_id?: string | null;
                actor_session_id?: string | null;
                comment_scope?: "passage" | "share";
                anchor?: ShareCommentDTO["anchor"];
                comment_body?: string;
                workspace_id?: string;
                session_id?: string;
                share_type?: string;
              };
              if (!p.share_id || !p.thread_id || !p.comment_id) continue;
              // The NATS payload doesn't carry seq or resolved-state —
              // applyServerEvent dedupes by `id` (UUID), so a partial
              // DTO is fine. seq=0 is a placeholder; when the operator
              // posts locally the optimistic-append uses the real seq.
              const now = new Date().toISOString();
              const dto: ShareCommentDTO = {
                id: p.comment_id,
                share_id: p.share_id,
                thread_id: p.thread_id,
                seq: 0,
                session_id: p.session_id ?? "",
                share_type: p.share_type ?? "site",
                scope: p.comment_scope ?? "share",
                anchor: p.anchor ?? null,
                body: p.comment_body ?? "",
                author_user_id: p.actor_user_id ?? null,
                author_session_id: p.actor_session_id ?? null,
                resolved_at: null,
                resolved_by_user_id: null,
                created_at: now,
                updated_at: now,
              };
              useShareCommentsStore.getState().applyServerEvent(dto);
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
  //
  // `take` reads + clears atomically, so a re-render can't refire the
  // send; we still guard with a ref for the same-render case.
  useEffect(() => {
    if (pendingPromptSentRef.current) return;
    if (!ncRef.current) return;
    if (!events.some((e) => e.type === "session.started")) return;
    const pending = takePendingPrompt(sessionId);
    if (!pending) return;
    pendingPromptSentRef.current = true;
    sendMessage(pending);
  }, [events, sessionId, takePendingPrompt]);

  // Deep-link: if the URL carries `?share=<shareId>`, open that share in
  // the right-rail artifact panel once the events stream loads it.
  // Pairs with the URL-write in artifactPanelStore.show/close so the URL
  // stays canonical: paste the URL → someone else lands on the same view.
  const showArtifact = useArtifactPanelStore((s) => s.show);
  const maximizeArtifact = useArtifactPanelStore((s) => s.maximize);
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get("share");
    if (!target) return;
    const evt = events.find(
      (e) =>
        e.type === "agent.share" &&
        (e.payload as { share_id?: string })?.share_id === target,
    );
    if (!evt) return; // events still streaming in; try again next render
    deepLinkAppliedRef.current = true;
    showArtifact({
      workspaceSlug,
      sessionId: evt.session_id ?? sessionId,
      artifact: evt.payload as AgentSharePayload,
    });
    if (params.get("mode") === "fullscreen") maximizeArtifact();
  }, [events, sessionId, workspaceSlug, showArtifact, maximizeArtifact]);

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
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShareOpen((v) => !v)}
        >
          <Share2 className="size-3.5" />
          <span className="ml-1">Share</span>
        </Button>
      }
    >
      <ShareSessionPanel
        workspaceSlug={workspaceSlug}
        sessionId={sessionId}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
      <div className="flex h-[calc(100svh-56px)] gap-3 bg-canvas p-3">
        <div className="surface-card flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-w-0 items-start gap-3 border-b border-border-soft px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <SessionTitle session={session ?? null} sessionId={sessionId} />
          </div>
          {/* X1A-37 — live cost block + transitive tree breakdown.
              Inline in the header (not a separate tab) per the
              greenlit mockup. live=true so the pulsing dot shows on
              the "this session" amount. */}
          <div className="hidden w-[18rem] shrink-0 md:block">
            <SessionCostBlock
              workspaceSlug={workspaceSlug}
              sessionId={sessionId}
              live={session?.status === "running" || session?.status === "pending"}
              lastEventSeq={events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs">
          {parent && (
            <a
              href={`/workspaces/${workspaceSlug}/sessions/${parent.session_id}`}
              className="inline-flex items-center gap-1 rounded-md border border-border-soft px-2 py-0.5 text-[11px] text-fg-muted hover:border-border-strong hover:text-fg"
              title={`spawned by session ${parent.session_id.slice(0, 8)}`}
            >
              <span className="text-fg-faint">from</span>
              <span>{parent.agent.name}</span>
            </a>
          )}
          {session?.resumed_from && (
            <a
              href={`/workspaces/${workspaceSlug}/sessions/${session.resumed_from}`}
              className="inline-flex items-center gap-1 rounded-md border border-border-soft px-2 py-0.5 text-[11px] text-fg-muted hover:border-border-strong hover:text-fg"
              title={`continues session ${session.resumed_from.slice(0, 8)}`}
            >
              <span className="text-fg-faint">resumed from</span>
              <span className="font-mono">
                {session.resumed_from.slice(0, 8)}
              </span>
            </a>
          )}
          <div className="ml-auto flex items-center gap-3">
            {session && (
              <span className={STATUS_COLOR[session.status]}>
                {session.status}
              </span>
            )}
            <span className="text-fg-faint/70">{events.length} events</span>
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
              className="h-7 text-[11px] text-fg-muted"
            >
              {verbose ? "Compact" : "Verbose"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="border-b border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <EventStream
          events={events}
          compactItems={compactItems}
          verbose={verbose}
          onRespond={sendMessage}
          workspaceSlug={workspaceSlug}
          agentId={agent?.id}
          sessionId={sessionId}
        />

        <div className="px-4 pt-3 pb-[60px]">
          <div className="mx-auto max-w-3xl">
            <TurnComposer
              onSend={sendMessage}
              disabled={disabled}
              running={session?.status === "running"}
              onStop={onPause}
              statusLabel={
                disabled
                  ? session?.status === "complete"
                    ? "Session ended"
                    : session?.status === "failed"
                      ? "Session failed"
                      : "Connecting…"
                  : null
              }
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
            {/* Compact "N child sessions running" counter, mirroring
                Claude Code's running-task affordance. The flyout
                anchors to the upper-right of this row so it floats
                above the composer rather than pushing it. */}
            <div className="mt-2 flex justify-end">
              <ChildWorkersCounter
                workspaceSlug={workspaceSlug}
                sessionId={sessionId}
              />
            </div>
          </div>
        </div>
        </div>
        <ArtifactPanel />
      </div>
    </AppShell>
  );
}
