import { create } from "zustand";
import type {
  SessionDTO,
  SessionEventDTO,
  SessionEventListResponse,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

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
 * call, return a new children list containing the freshly spawned
 * child. Otherwise return `null` so the caller knows to leave the
 * existing reference intact (selectors stay referentially stable).
 *
 * Exported so tests can hit the parser directly without driving a
 * full NATS round-trip.
 */
export function childrenAfterEvent(
  current: ChildRef[],
  ev: SessionEventDTO,
): ChildRef[] | null {
  if (ev.type !== "agent.tool_result") return null;
  const child = parseSpawnSessionResult(ev.payload);
  if (!child) return null;
  if (current.some((c) => c.id === child.id)) return null;
  return [...current, child];
}

/**
 * The `spawn_session` MCP handler stringifies the api's `{ session: {...} }`
 * response into a single `text` block of MCP content. This walks
 * that shape defensively — any deviation from the expected schema
 * causes us to bail out (return null) rather than throw mid-render.
 */
function parseSpawnSessionResult(payload: unknown): ChildRef | null {
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
    const id = typeof sObj["id"] === "string" ? (sObj["id"] as string) : null;
    if (!id) continue;
    const agentId =
      typeof sObj["agent_id"] === "string" ? (sObj["agent_id"] as string) : id;
    const status =
      sObj["status"] === "pending" ||
      sObj["status"] === "running" ||
      sObj["status"] === "complete" ||
      sObj["status"] === "failed"
        ? (sObj["status"] as ChildRef["status"])
        : "pending";
    const triggeredAt =
      typeof sObj["triggered_at"] === "string"
        ? (sObj["triggered_at"] as string)
        : new Date().toISOString();
    return {
      id,
      status,
      triggered_at: triggeredAt,
      agent: {
        id: agentId,
        // Slug + display name are not in the spawn response; surface
        // a stable placeholder until either the user refreshes or
        // X1A-7 backfills.
        slug: agentId,
        name: "Child session",
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
  statusBySession: Record<string, ConnStatus>;
  errorBySession: Record<string, string | null>;

  loadInitial(workspaceSlug: string, sessionId: string): Promise<void>;
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
 * `maxSeqBySession` de-dupes between the two streams.
 */
export const useSessionDetailStore = create<SessionDetailState>((set) => ({
  sessionsById: {},
  agentsBySession: {},
  parentBySession: {},
  childrenBySession: {},
  eventsBySession: {},
  statusBySession: {},
  errorBySession: {},

  async loadInitial(workspaceSlug, sessionId) {
    set((s) => ({
      statusBySession: {
        ...s.statusBySession,
        [sessionId]: "connecting",
      },
      errorBySession: { ...s.errorBySession, [sessionId]: null },
    }));
    try {
      const res = await apiFetch<SessionEventListResponse>(
        `/api/workspaces/${workspaceSlug}/sessions/${sessionId}/events`,
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
        childrenBySession: {
          ...s.childrenBySession,
          [sessionId]: res.children ?? [],
        },
        eventsBySession: { ...s.eventsBySession, [sessionId]: merged },
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

      // Real-time child-worker tracking. An orchestrator's NATS event
      // stream emits `agent.tool_result` for every MCP call, including
      // the platform's own `spawn_session`. We sniff that result and
      // append the new child to `childrenBySession` so the
      // ChildWorkersCounter reflects the new spawn without a refetch
      // or a fresh poll. The server-side spawn route returns the same
      // `{ session: { id, agent_id, status, triggered_at, ... } }`
      // shape we mirror in the store; everything else (display name)
      // stays as a placeholder until the operator either refreshes or
      // X1A-7 ships LLM summaries that backfill names too.
      const childrenUpdate = childrenAfterEvent(
        s.childrenBySession[sessionId] ?? [],
        ev,
      );

      return {
        eventsBySession: {
          ...s.eventsBySession,
          [sessionId]: [...cur, ev],
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
