import { create } from "zustand";
import type {
  SessionDTO,
  SessionEventDTO,
  SessionEventListResponse,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";
import {
  compactTimeline,
  type CompactItem,
} from "../features/sessions/eventClassification";

type ConnStatus = "connecting" | "live" | "ended" | "error";

type AgentRef = { id: string; slug: string; name: string };
type ParentRef = { session_id: string; agent: AgentRef };
export type ChildRef = {
  id: string;
  status: SessionDTO["status"];
  triggered_at: string;
  agent: AgentRef;
};

/**
 * If `ev` is the durable record of a successful `spawn_session` MCP
 * call attributable to `parentSessionId`, return a new children list
 * with the freshly spawned (or status-updated) child folded in.
 * Otherwise return `null` so the caller leaves the existing reference
 * intact — that keeps zustand selectors referentially stable.
 *
 * Behaviour:
 *  - Strict bail on `tool_error` / `is_error: true`.
 *  - Strict bail unless the parsed `parent_session_id` matches the
 *    session we're tracking. This binds the parser to the right
 *    spawn (defence against a malicious agent emitting a fake
 *    `agent.tool_result` for a spawn it didn't perform), and prevents
 *    foreign-tenant ids from sneaking into our DOM.
 *  - On duplicate id, **upsert** (overwrite status/triggered_at) so a
 *    child's pending → running → complete progression actually flows
 *    into the counter / flyout — vs. the previous bail-on-dup that
 *    pinned the row to its first state.
 *
 * Exported so tests can hit the parser directly without driving a
 * full NATS round-trip.
 */
export function childrenAfterEvent(
  current: ChildRef[],
  ev: SessionEventDTO,
  parentSessionId: string,
): ChildRef[] | null {
  if (ev.type !== "agent.tool_result") return null;
  const child = parseSpawnSessionResult(ev.payload, parentSessionId);
  if (!child) return null;
  const idx = current.findIndex((c) => c.id === child.id);
  if (idx === -1) return [...current, child];
  // Upsert — keep the existing record's resolved agent name (if any)
  // since loadInitial fills `agent.name` from the api but the spawn
  // tool_result carries only an agent_id. New status/triggered_at
  // win; the resolved name is preferred over the placeholder.
  const existing = current[idx]!;
  const keepExistingAgent =
    existing.agent.name &&
    existing.agent.name !== PLACEHOLDER_AGENT_NAME;
  const mergedAgent = keepExistingAgent ? existing.agent : child.agent;
  if (
    existing.status === child.status &&
    existing.triggered_at === child.triggered_at &&
    sameAgent(existing.agent, mergedAgent)
  ) {
    // Genuinely no-op — preserve referential stability for selectors.
    return null;
  }
  const merged: ChildRef = {
    id: child.id,
    status: child.status,
    triggered_at: child.triggered_at,
    agent: mergedAgent,
  };
  const next = current.slice();
  next[idx] = merged;
  return next;
}

function sameAgent(a: ChildRef["agent"], b: ChildRef["agent"]): boolean {
  return a.id === b.id && a.slug === b.slug && a.name === b.name;
}

const PLACEHOLDER_AGENT_NAME = "Child session";

/**
 * Merge the api's authoritative child list with whatever the store
 * already had (typically rows appended by the spawn-result sniffer
 * while the api fetch was in flight). Server rows win on every
 * field; rows the server doesn't know about yet are preserved so an
 * in-flight spawn isn't silently dropped on a refresh.
 */
function mergeChildren(
  current: ReadonlyArray<ChildRef>,
  incoming: ReadonlyArray<ChildRef>,
): ChildRef[] {
  const byId = new Map<string, ChildRef>();
  for (const c of current) byId.set(c.id, c);
  for (const c of incoming) byId.set(c.id, c);
  return Array.from(byId.values());
}

// Lower-cased UUID v4-ish. Loose enough to also accept v1/v5 shapes
// the database may produce; tight enough to refuse path traversal
// payloads ("../../foo") in router-bound interpolations.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * The `spawn_session` MCP handler stringifies the api's `{ session: {...} }`
 * response into a single `text` block of MCP content. This walks
 * that shape defensively — any deviation from the expected schema
 * causes us to bail out (return null) rather than throw mid-render
 * or pollute the store with a half-baked row.
 */
function parseSpawnSessionResult(
  payload: unknown,
  parentSessionId: string,
): ChildRef | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { content?: unknown; is_error?: unknown };
  if (p.is_error === true) return null;
  if (!Array.isArray(p.content)) return null;
  for (const block of p.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== "text" || typeof b.text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as { session?: unknown };
    const session = obj.session;
    if (!session || typeof session !== "object") continue;
    const sObj = session as Record<string, unknown>;
    if (!isUuid(sObj["id"])) continue;
    if (!isUuid(sObj["parent_session_id"])) continue;
    // Bind to the parent we're tracking. A spawn the orchestrator
    // legitimately performed always carries our session id; anything
    // else is either a bug or an injection.
    if (sObj["parent_session_id"] !== parentSessionId) continue;
    const id = sObj["id"] as string;
    const agentIdRaw = sObj["agent_id"];
    const agentId = isUuid(agentIdRaw) ? (agentIdRaw as string) : null;
    if (!agentId) continue;
    const status =
      sObj["status"] === "pending" ||
      sObj["status"] === "running" ||
      sObj["status"] === "complete" ||
      sObj["status"] === "failed"
        ? (sObj["status"] as ChildRef["status"])
        : "pending";
    const triggeredAtRaw = sObj["triggered_at"];
    const triggeredAt =
      typeof triggeredAtRaw === "string" &&
      Number.isFinite(Date.parse(triggeredAtRaw))
        ? triggeredAtRaw
        : new Date().toISOString();
    return {
      id,
      status,
      triggered_at: triggeredAt,
      agent: {
        id: agentId,
        // Slug + display name are not in the spawn response; surface
        // a stable placeholder until either the user refreshes or
        // X1A-7 backfills. The placeholder name is also the sentinel
        // childrenAfterEvent uses to decide when to swap in the
        // loadInitial-resolved name during an upsert.
        slug: agentId,
        name: PLACEHOLDER_AGENT_NAME,
      },
    };
  }
  return null;
}

interface SessionDetailState {
  sessionsById: Record<string, SessionDTO>;
  agentsBySession: Record<string, AgentRef>;
  parentBySession: Record<string, ParentRef | null>;
  childrenBySession: Record<string, ChildRef[]>;
  eventsBySession: Record<string, SessionEventDTO[]>;
  /**
   * Pre-computed compact timeline for each session — derived from
   * `eventsBySession` and refreshed every time the events array
   * changes. Cached here so `EventStream` doesn't recompute the
   * grouping on every render and so the items array reference stays
   * stable across unrelated store updates (which lets `React.memo`
   * on `EventCard` actually skip work).
   */
  compactItemsBySession: Record<string, CompactItem[]>;
  statusBySession: Record<string, ConnStatus>;
  errorBySession: Record<string, string | null>;
  /**
   * X1A-72.3 — has the server confirmed there are older events the
   * client hasn't fetched yet? `true` whenever the most recent
   * loadInitial / loadOlder returned exactly INITIAL_TAIL_LIMIT
   * events (i.e. we likely hit the cap, more probably exists).
   */
  hasOlderBySession: Record<string, boolean>;
  /** Mutex-style guard — prevents fan-out on rapid scroll-to-top. */
  loadingOlderBySession: Record<string, boolean>;

  loadInitial(workspaceSlug: string, sessionId: string): Promise<void>;
  /**
   * X1A-72.3 — fetch the window of events strictly older than the
   * oldest event currently in the store, and prepend them. No-op if
   * `hasOlderBySession[sessionId]` is false or another loadOlder is
   * already in flight for this session.
   */
  loadOlder(workspaceSlug: string, sessionId: string): Promise<void>;
  /**
   * Append one event to the session's stream. Dedup is by the
   * `(seq, type)` tuple — any event with a combination we already
   * have is dropped. This matches the reference pattern and handles
   * every case we care about: REST-fetched historical events replayed
   * while the WS is also live, local echoes vs eventual server events,
   * and accidental double-subscribes.
   *
   * No watermark is used, so out-of-order arrivals are fine as long as
   * the (seq, type) combinations are unique within their domain.
   * Local echoes — type "user.message" with sequences the server never
   * emits — cannot collide with server events since the server never
   * emits that type.
   */
  appendEvent(sessionId: string, ev: SessionEventDTO): void;
  setStatus(sessionId: string, status: ConnStatus): void;
  setError(sessionId: string, msg: string | null): void;
  /**
   * Replace the cached session record. Used after a mutation that
   * changes the session's status (e.g. POST /cancel) so the detail
   * page reflects the new state without re-fetching.
   */
  setSession(sessionId: string, session: SessionDTO): void;
}

/**
 * Backs the session detail page. `loadInitial` hits the workspace-scoped
 * `/sessions/:id/events` endpoint for durable history; the page then
 * subscribes to NATS for live events and calls `appendEvent` on each.
 * `appendEvent` de-dupes by `(seq, type)` so the REST replay and the
 * live NATS stream can overlap without double-rendering.
 */
// X1A-72.3 — initial tail size. 100 events is enough to render the
// "what's happening right now" view without blocking paint on
// thousand-event sessions. Scrolling up triggers loadOlder for the
// next window. The same constant guards the "has older?" decision —
// if the server returned exactly this many, more probably exists.
const INITIAL_TAIL_LIMIT = 100;
// Sentinel for "I want the latest events" via the unified before_seq
// pagination shape. session_events.seq is BIGINT so any value within
// Number.MAX_SAFE_INTEGER round-trips cleanly to Postgres.
const FUTURE_SEQ_SENTINEL = Number.MAX_SAFE_INTEGER;

export const useSessionDetailStore = create<SessionDetailState>((set, get) => ({
  sessionsById: {},
  agentsBySession: {},
  parentBySession: {},
  childrenBySession: {},
  eventsBySession: {},
  compactItemsBySession: {},
  statusBySession: {},
  errorBySession: {},
  hasOlderBySession: {},
  loadingOlderBySession: {},

  async loadInitial(workspaceSlug, sessionId) {
    set((s) => ({
      statusBySession: {
        ...s.statusBySession,
        [sessionId]: "connecting",
      },
      errorBySession: { ...s.errorBySession, [sessionId]: null },
    }));
    try {
      // X1A-72.3 — fetch only the tail of the event stream so big
      // sessions don't block paint. Use the unified before_seq+limit
      // shape: a sentinel future seq + limit=N returns the latest N
      // events, oldest-first. Scrolling up triggers loadOlder for the
      // preceding window.
      const res = await apiFetch<SessionEventListResponse>(
        `/api/workspaces/${workspaceSlug}/sessions/${sessionId}/events?before_seq=${FUTURE_SEQ_SENTINEL}&limit=${INITIAL_TAIL_LIMIT}`,
      );

      // When this session resumes a prior one, fetch the prior
      // session's events and prepend them with a synthetic
      // `session.resumed` divider. The divider sequence is negative so
      // it sorts before every real event; the prior events get
      // negative sequences in the 1000s range for the same reason.
      let merged = res.events;
      const resumedFrom = res.session.resumed_from;
      if (resumedFrom) {
        try {
          const prior = await apiFetch<SessionEventListResponse>(
            `/api/workspaces/${workspaceSlug}/sessions/${resumedFrom}/events`,
          );
          const priorEvents = prior.events.map((e, idx) => ({
            ...e,
            id: `prior-${e.id}`,
            session_id: resumedFrom,
            seq: -10000 - (prior.events.length - idx),
          }));
          const divider: SessionEventDTO = {
            id: `resume-divider-${sessionId}`,
            session_id: sessionId,
            seq: -1,
            type: "session.resumed",
            payload: {
              message: "Session resumed",
              previous_session_id: resumedFrom,
            },
            timestamp:
              res.session.triggered_at ??
              res.events[0]?.timestamp ??
              new Date().toISOString(),
          };
          merged = [...priorEvents, divider, ...res.events];
        } catch {
          // Prior session may have been deleted or access was denied.
          // Fall back to just the current session's events.
        }
      }

      set((s) => ({
        sessionsById: { ...s.sessionsById, [sessionId]: res.session },
        agentsBySession: { ...s.agentsBySession, [sessionId]: res.agent },
        parentBySession: {
          ...s.parentBySession,
          [sessionId]: res.parent ?? null,
        },
        // Merge by id rather than replace. The current code path
        // awaits loadInitial before subscribing to NATS, so any
        // childrenAfterEvent appends today happen *after* this set —
        // safe. But a future caller that re-runs loadInitial with a
        // live subscription (focus refresh, manual reload) would
        // otherwise wipe in-flight appends. Server rows win on field
        // values; placeholder rows survive only when the server
        // doesn't (yet) know about them.
        childrenBySession: {
          ...s.childrenBySession,
          [sessionId]: mergeChildren(
            s.childrenBySession[sessionId] ?? [],
            res.children ?? [],
          ),
        },
        eventsBySession: { ...s.eventsBySession, [sessionId]: merged },
        compactItemsBySession: {
          ...s.compactItemsBySession,
          [sessionId]: compactTimeline(merged),
        },
        // We hit the cap → there's almost certainly older history we
        // didn't fetch. Resume-stitched events (negative seq prior
        // events + divider) are local-only; the gate is about the
        // CURRENT session's history, so check the API result, not the
        // merged list.
        hasOlderBySession: {
          ...s.hasOlderBySession,
          [sessionId]: res.events.length >= INITIAL_TAIL_LIMIT,
        },
      }));
    } catch (err) {
      set((s) => ({
        statusBySession: { ...s.statusBySession, [sessionId]: "error" },
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: (err as Error).message,
        },
      }));
    }
  },

  async loadOlder(workspaceSlug, sessionId) {
    const s = get();
    if (!s.hasOlderBySession[sessionId]) return;
    if (s.loadingOlderBySession[sessionId]) return;
    const cur = s.eventsBySession[sessionId] ?? [];
    // Anchor: first event whose seq is >= 0. Negative seqs are the
    // resume-stitched prior-session events (synthesised client-side);
    // we never page through those.
    const firstReal = cur.find((e) => e.seq >= 0);
    if (!firstReal) return;
    set((prev) => ({
      loadingOlderBySession: {
        ...prev.loadingOlderBySession,
        [sessionId]: true,
      },
    }));
    try {
      const res = await apiFetch<SessionEventListResponse>(
        `/api/workspaces/${workspaceSlug}/sessions/${sessionId}/events?before_seq=${firstReal.seq}&limit=${INITIAL_TAIL_LIMIT}`,
      );
      set((prev) => {
        const existing = prev.eventsBySession[sessionId] ?? [];
        // Dedup against the existing window in case of overlap (the
        // server returns up to `limit` events with seq < firstReal.seq;
        // anything we already have is dropped). Same (seq, type) key
        // appendEvent uses.
        const seen = new Set(existing.map((e) => `${e.seq}:${e.type}`));
        const fresh = res.events.filter(
          (e) => !seen.has(`${e.seq}:${e.type}`),
        );
        // Merge then sort ascending — the prior-session prepend at
        // loadInitial used negative seqs so this sort still places the
        // resume divider + prior events at the top.
        const next = [...fresh, ...existing].sort((a, b) => a.seq - b.seq);
        return {
          eventsBySession: { ...prev.eventsBySession, [sessionId]: next },
          compactItemsBySession: {
            ...prev.compactItemsBySession,
            [sessionId]: compactTimeline(next),
          },
          hasOlderBySession: {
            ...prev.hasOlderBySession,
            [sessionId]: res.events.length >= INITIAL_TAIL_LIMIT,
          },
          loadingOlderBySession: {
            ...prev.loadingOlderBySession,
            [sessionId]: false,
          },
        };
      });
    } catch (err) {
      set((prev) => ({
        loadingOlderBySession: {
          ...prev.loadingOlderBySession,
          [sessionId]: false,
        },
        errorBySession: {
          ...prev.errorBySession,
          [sessionId]: (err as Error).message,
        },
      }));
    }
  },

  appendEvent(sessionId, ev) {
    set((s) => {
      const cur = s.eventsBySession[sessionId] ?? [];
      // Dedup by (seq, type). An event with the same tuple has already
      // been delivered — whether from REST on initial load, from a
      // prior NATS delivery, or from an accidental double-subscribe.
      // Local echoes are safe against server events because the server
      // never emits `user.message` as its own event type.
      const exists = cur.some(
        (e) => e.seq === ev.seq && e.type === ev.type,
      );
      if (exists) return s;

      let sessions = s.sessionsById;
      if (
        (ev.type === "session.completed" || ev.type === "session.failed") &&
        sessions[sessionId]
      ) {
        sessions = {
          ...sessions,
          [sessionId]: {
            ...(sessions[sessionId] as SessionDTO),
            status: ev.type === "session.completed" ? "complete" : "failed",
            completed_at: new Date().toISOString(),
          },
        };
      }
      // X1A-66 — flip the status pill from `pending` to `running` the
      // moment `session.started` arrives. The server-side row also
      // flips (job-watcher + NATS subscriber both do it), but the
      // client cache was previously only listening for terminal
      // transitions — so after a stop→resume the pill stayed on
      // `pending` even as tool_calls and agent.text were streaming
      // in. Idempotent: only nudges `pending`, leaves any other
      // status alone.
      if (ev.type === "session.started" && sessions[sessionId]) {
        const cur = sessions[sessionId] as SessionDTO;
        if (cur.status === "pending") {
          sessions = {
            ...sessions,
            [sessionId]: { ...cur, status: "running" },
          };
        }
      }

      // Real-time child-worker tracking. An orchestrator's NATS event
      // stream emits `agent.tool_result` for every MCP call, including
      // the platform's own `spawn_session`. We sniff that result and
      // append (or upsert) the matching child into
      // `childrenBySession` so the ChildWorkersCounter reflects the
      // new spawn without a refetch or a fresh poll. The parser is
      // bound to `sessionId` — only spawn results whose
      // `parent_session_id` matches the session we're rendering are
      // accepted, which keeps an unrelated tool emitting a
      // `{session: ...}` shape from injecting phantom rows.
      const childrenUpdate = childrenAfterEvent(
        s.childrenBySession[sessionId] ?? [],
        ev,
        sessionId,
      );

      const nextEvents = [...cur, ev];
      return {
        eventsBySession: {
          ...s.eventsBySession,
          [sessionId]: nextEvents,
        },
        compactItemsBySession: {
          ...s.compactItemsBySession,
          [sessionId]: compactTimeline(nextEvents),
        },
        sessionsById: sessions,
        childrenBySession: childrenUpdate
          ? { ...s.childrenBySession, [sessionId]: childrenUpdate }
          : s.childrenBySession,
      };
    });
  },

  setStatus(sessionId, status) {
    set((s) => ({
      statusBySession: { ...s.statusBySession, [sessionId]: status },
    }));
  },

  setError(sessionId, msg) {
    set((s) => ({
      errorBySession: { ...s.errorBySession, [sessionId]: msg },
    }));
  },

  setSession(sessionId, session) {
    set((s) => ({
      sessionsById: { ...s.sessionsById, [sessionId]: session },
    }));
  },
}));
