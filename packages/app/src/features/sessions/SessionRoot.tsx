import { useEffect, useRef, useState } from "react";
import {
  openBridge,
  type BridgeHandle,
  type BridgeCommentEvent,
} from "../../lib/wsBridge";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { useAuthStore } from "../../stores/authStore";
import { useSessionDetailStore } from "../../stores/sessionDetailStore";
import { useShallow } from "zustand/react/shallow";
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
import {
  useTypingIndicatorStore,
  extractCorrelatedEventId,
} from "../../stores/typingIndicatorStore";
import { MainTimelineTypingIndicators } from "./TypingIndicator";

// Stable empty references for the per-session selectors. Inlining
// `?? []` or `?? new Array()` outside the selector mints a fresh
// reference each render and tanks React.memo on downstream consumers
// (see project memory: zustand-foot-gun).
const EMPTY_EVENTS: ReadonlyArray<never> = Object.freeze([]);
const EMPTY_COMPACT_ITEMS: ReadonlyArray<never> = Object.freeze([]);

interface Props {
  workspaceSlug: string;
  sessionId: string;
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  pending: "text-fg-muted",
  running: "text-blue-400",
  complete: "text-emerald-400",
  failed: "text-red-400",
};

export function SessionRoot({ workspaceSlug, sessionId }: Props) {
  const { status: authStatus, fetchMe } = useAuthStore();
  // Per-session selectors — each subscribes only to THIS session's
  // slice of the store. Without this, SessionRoot re-rendered on
  // every WS message in any session (the whole-store destructure used
  // to live here), which cascaded down to a full EventStream rebuild
  // on every keystroke — visible as iPad typing lag.
  const session = useSessionDetailStore((s) => s.sessionsById[sessionId]);
  const agent = useSessionDetailStore((s) => s.agentsBySession[sessionId]);
  const parent =
    useSessionDetailStore((s) => s.parentBySession[sessionId]) ?? null;
  const events =
    useSessionDetailStore((s) => s.eventsBySession[sessionId]) ?? EMPTY_EVENTS;
  const error = useSessionDetailStore((s) => s.errorBySession[sessionId]);
  // Actions never change reference — destructure with useShallow on a
  // single render so React.memo'd children never see new function
  // identities from us.
  const { loadInitial, loadOlder, loadChildren, appendEvent, setError, setSession } =
    useSessionDetailStore(
      useShallow((s) => ({
        loadInitial: s.loadInitial,
        loadOlder: s.loadOlder,
        loadChildren: s.loadChildren,
        appendEvent: s.appendEvent,
        setError: s.setError,
        setSession: s.setSession,
      })),
    );
  const hasOlder = useSessionDetailStore(
    (s) => s.hasOlderBySession[sessionId] ?? false,
  );
  const loadingOlder = useSessionDetailStore(
    (s) => s.loadingOlderBySession[sessionId] ?? false,
  );

  const [verbose, setVerbose] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const bridgeRef = useRef<BridgeHandle | null>(null);
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

  // `session`, `agent`, `parent`, `events`, `error` are subscribed
  // above via per-session selectors so we re-render only when THIS
  // session's slice changes.
  const compactItems =
    useSessionDetailStore((s) => s.compactItemsBySession[sessionId]) ?? EMPTY_COMPACT_ITEMS;

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
    let hbInterval: ReturnType<typeof setInterval> | null = null;
    let visibilityHandler: (() => void) | null = null;

    (async () => {
      await loadInitial(workspaceSlug, sessionId);
      if (cancelled) return;

      const handleSessionEvent = (msg: {
        session_id: string;
        sequence: number;
        type: string;
        payload: unknown;
        timestamp: string;
      }) => {
        // X1A-104: `session.agent_thinking` is transient — it
        // travels over the same WS channel but is NOT persisted
        // to the timeline. Route it into the typing-indicator
        // store and skip `appendEvent` so it doesn't pollute
        // the durable event list or trigger the dedupe path.
        if (msg.type === "session.agent_thinking") {
          const p = (msg.payload ?? {}) as {
            share_id?: string | null;
            thread_id?: string | null;
            event_id?: string | null;
            wake_source?: string;
            started_at?: string;
          };
          if (typeof p.event_id === "string" && p.event_id) {
            useTypingIndicatorStore.getState().add(sessionId, {
              event_id: p.event_id,
              share_id:
                typeof p.share_id === "string" ? p.share_id : null,
              thread_id:
                typeof p.thread_id === "string" ? p.thread_id : null,
              started_at:
                typeof p.started_at === "string"
                  ? p.started_at
                  : msg.timestamp,
              wake_source:
                typeof p.wake_source === "string"
                  ? p.wake_source
                  : "unknown",
            });
          }
          return;
        }

        const ev: SessionEventDTO = {
          id: `nats-${msg.session_id}-${msg.sequence}`,
          session_id: msg.session_id,
          seq: msg.sequence,
          type: msg.type,
          payload: msg.payload,
          timestamp: msg.timestamp,
        };

        // X1A-104 clear-signal: if this agent emission carries
        // a wake correlation id (`event_id` / `in_reply_to` /
        // `triggered_by` from X1A-103's propagation contract),
        // clear the matching indicator.
        const correlated = extractCorrelatedEventId(
          ev as unknown as Record<string, unknown>,
        );
        if (correlated) {
          useTypingIndicatorStore
            .getState()
            .clearByEventId(sessionId, correlated);
        }

        // Live-update the right-rail artifact when the agent re-emits a
        // share for the same share_id. The artifactPanelStore no-ops if
        // the open panel doesn't match, so this is cheap on every share.
        if (msg.type === "agent.share") {
          const p = msg.payload as { share_id?: string } | null;
          if (p && typeof p.share_id === "string") {
            useArtifactPanelStore
              .getState()
              .replaceArtifact(p as unknown as AgentSharePayload);
          }
        }

        appendEvent(sessionId, ev);
      };

      const handleCommentEvent = (
        kind: "added" | "resolved",
        p: BridgeCommentEvent,
      ) => {
        if (kind !== "added") {
          // Thread-resolved relays are passed through here but the
          // current UI does its own poll-on-toggle; bail until the
          // store grows a resolved-event handler.
          return;
        }
        // Bridge guarantees these three are present; defense in depth.
        if (!p.share_id || !p.thread_id || !p.comment_id) return;
        // Server-stamped time if the bridge carried it; only fall back
        // to client wall-clock when an older api version doesn't yet
        // emit created_at on the wire. The fallback path is the
        // pre-fix behaviour and races vs server time, which is what
        // produced visibly-wrong thread ordering when REST-loaded
        // (server-time) and NATS-delivered (client-time) comments
        // were interleaved.
        const stamp = p.created_at ?? new Date().toISOString();
        const dto: ShareCommentDTO = {
          id: p.comment_id,
          share_id: p.share_id,
          thread_id: p.thread_id,
          seq: 0,
          session_id: p.session_id ?? "",
          share_type: p.share_type ?? "site",
          scope: (p.comment_scope as "passage" | "share" | null) ?? "share",
          anchor: (p.anchor as ShareCommentDTO["anchor"]) ?? null,
          body: p.comment_body ?? "",
          author_user_id: p.actor_user_id,
          author_session_id: p.actor_session_id,
          resolved_at: null,
          resolved_by_user_id: null,
          created_at: stamp,
          updated_at: stamp,
          parent_comment_id: p.parent_comment_id,
        };
        useShareCommentsStore.getState().applyServerEvent(dto);
      };

      const bridge = openBridge({
        onSessionEvent: handleSessionEvent,
        onCommentEvent: handleCommentEvent,
        onOpen: () => {
          // Heartbeat lives on the open event so a reconnect re-kicks
          // it from scratch. The bridge client guarantees subscriptions
          // are re-issued before this fires.
          if (cancelled) return;
          bridge.publishPresence(sessionId);
        },
      });
      if (cancelled) {
        bridge.close();
        return;
      }
      bridgeRef.current = bridge;
      bridge.subscribeSession(sessionId);
      bridge.subscribeComments();

      // Presence / stay-alive: the agent's idle timer starts counting
      // down as soon as the conversation is quiet. The browser pings
      // `x1.session.{id}.presence` through the bridge; the sidecar
      // forwards each ping to the agent's /keepalive endpoint to
      // reset the idle timer.
      //
      // Cadence: every 20s, plus an extra ping on tab refocus
      // (setInterval can stall in backgrounded tabs).
      hbInterval = setInterval(() => {
        bridge.publishPresence(sessionId);
      }, 20_000);
      visibilityHandler = () => {
        if (document.visibilityState === "visible") {
          bridge.publishPresence(sessionId);
        }
      };
      document.addEventListener("visibilitychange", visibilityHandler);
    })();

    return () => {
      cancelled = true;
      if (hbInterval) clearInterval(hbInterval);
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
      bridgeRef.current?.close();
      bridgeRef.current = null;
      // X1A-104: indicators are transient — dropping them on unmount
      // matches the "fresh page load = clean" rule from X1A-103.
      useTypingIndicatorStore.getState().clearAllForSession(sessionId);
    };
  }, [workspaceSlug, sessionId, loadInitial, appendEvent, setError]);

  // X1A-60 — poll the children list while the parent is alive. The
  // parent's NATS stream doesn't fire when a child's lifecycle
  // changes, and the spawn-result sniffer in sessionDetailStore is
  // best-effort (races on subscribe, bails on payload-shape drift).
  // 4s is a balance: tight enough to feel live, sparse enough that
  // a long-running orchestrator doesn't generate one request per
  // second forever. Stops when the session is no longer running.
  useEffect(() => {
    if (!session) return;
    const alive =
      session.status === "running" || session.status === "pending";
    if (!alive) return;
    // Fire immediately so the counter is correct on landing, then
    // every 4 seconds.
    void loadChildren(workspaceSlug, sessionId);
    const id = setInterval(() => {
      void loadChildren(workspaceSlug, sessionId);
    }, 4000);
    return () => clearInterval(id);
  }, [workspaceSlug, sessionId, session?.status, loadChildren]);

  // User input TTL: drop messages older than this on the consumer.
  // 2 min is "long enough to cover pod warmup (~30s typical, ~2min
  // worst-case on cold image pull) but short enough that a stale
  // message can't run surprise commands hours later when an old
  // session is revived." Same constant lives in
  // packages/api/src/orchestration/wake-publisher.ts for server-side
  // wakes; centralise once the wake-kind→ttl table grows past two
  // entries.
  const USER_INPUT_TTL_MS = 2 * 60 * 1000;

  const sendMessage = async (text: string, requestId?: string) => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const basePayload: Record<string, unknown> = { text };
    const payload: Record<string, unknown> = { ...basePayload };
    if (requestId) {
      payload["request_id"] = requestId;
      payload["answer"] = text;
    }
    // X1A-103: stamp a client-minted event_id so the agent's
    // `session.agent_thinking` indicator and the agent's first reply
    // both carry it through. The frontend (X1A-104) uses it to clear
    // the right indicator when two wakes overlap.
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      payload["event_id"] = crypto.randomUUID();
    }
    payload["wake_source"] = "user";
    // The agent emits a user.message (or user.input_response) to its
    // SSE stream on inject, which the sidecar publishes to NATS and
    // the api persists to session_events. The browser picks up that
    // same event via its NATS subscription — so we do NOT add a local
    // echo here.
    const seq = seqRef.current++;
    const msgId = `${sessionId}:${seq}:${Date.now()}`;
    const now = Date.now();
    const envelope = {
      session_id: sessionId,
      timestamp: new Date(now).toISOString(),
      sequence: seq,
      type: requestId ? "user.input_response" : "user.message",
      expires_at: now + USER_INPUT_TTL_MS,
      payload,
    };
    try {
      await bridge.publishInput(envelope, msgId);
    } catch (err) {
      // The bridge raises on JetStream publish failure (broker
      // unreachable, stream not provisioned, ACK timeout). Bubble up
      // so the composer can show "Send failed — retry".
      throw new Error(
        `failed to publish user input: ${(err as Error).message}`,
      );
    }
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
    if (!bridgeRef.current) return;
    if (!events.some((e) => e.type === "session.started")) return;
    const pending = takePendingPrompt(sessionId);
    if (!pending) return;
    pendingPromptSentRef.current = true;
    void sendMessage(pending).catch((err) => {
      console.error("[pending-prompt] send failed", err);
    });
  }, [events, sessionId, takePendingPrompt]);

  // Deep-link: if the URL carries `?share=<shareId>`, open that share in
  // the right-rail artifact panel once the events stream loads it.
  // Pairs with the URL-write in artifactPanelStore.show/close so the URL
  // stays canonical: paste the URL → someone else lands on the same view.
  const showArtifact = useArtifactPanelStore((s) => s.show);
  const maximizeArtifact = useArtifactPanelStore((s) => s.maximize);
  const setCommentsCollapsed = useArtifactPanelStore(
    (s) => s.setCommentsCollapsed,
  );
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
    // Comments sidebar starts collapsed when the user navigates directly
    // to a share (deep-link or fullscreen). They opened the share to
    // read it; if they want comments, they can expand from the gutter.
    setCommentsCollapsed(true);
    // Scroll the matching share pill to the center of the timeline so
    // the user lands on the share they followed in, not at the bottom
    // of the conversation. The pill is tagged with `data-share-id` by
    // SharePill. Use requestAnimationFrame so the EventStream has
    // finished its initial layout (and its own jump-to-bottom) first;
    // our center-scroll wins on the next paint.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-share-id="${CSS.escape(target)}"]`,
      );
      if (el) el.scrollIntoView({ behavior: "auto", block: "center" });
    });
  }, [
    events,
    sessionId,
    workspaceSlug,
    showArtifact,
    maximizeArtifact,
    setCommentsCollapsed,
  ]);

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
      {/* iOS Safari quirk: with `100svh` (smallest viewport), opening
          the on-screen keyboard makes the page taller than the visible
          area, the browser auto-scrolls to keep the composer in view,
          and after the keyboard dismisses the scroll offset doesn't
          reset — leaves a 150–200px gap at the bottom that doesn't
          reclaim. `100dvh` follows the actual visible viewport
          including the keyboard, so the layout shrinks while the
          keyboard is open and grows back when it closes, no stuck
          scroll. */}
      <div className="flex h-[calc(100dvh-56px)] gap-3 bg-canvas p-3">
        <div className="surface-card flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-w-0 items-center gap-3 border-b border-border-soft px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <SessionTitle session={session ?? null} sessionId={sessionId} />
          </div>
          {/* X1A-37 — live cost block + transitive tree breakdown.
              Inline in the header (not a separate tab) per the
              greenlit mockup. live=true so the pulsing dot shows on
              the "this session" amount. */}
          <div className="hidden shrink-0 md:block">
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
          tailSlot={<MainTimelineTypingIndicators sessionId={sessionId} />}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={() => loadOlder(workspaceSlug, sessionId)}
        />

        <div className="px-4 pt-3 pb-[60px]">
          <div className="mx-auto max-w-3xl">
            <TurnComposer
              onSend={sendMessage}
              disabled={disabled}
              running={session?.status === "running"}
              onStop={onPause}
              sessionId={sessionId}
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
