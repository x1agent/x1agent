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
type ChildRef = {
  id: string;
  status: SessionDTO["status"];
  triggered_at: string;
  agent: AgentRef;
};

interface SessionDetailState {
  sessionsById: Record<string, SessionDTO>;
  agentsBySession: Record<string, AgentRef>;
  parentBySession: Record<string, ParentRef | null>;
  childrenBySession: Record<string, ChildRef[]>;
  eventsBySession: Record<string, SessionEventDTO[]>;
  maxSeqBySession: Record<string, number>;
  statusBySession: Record<string, ConnStatus>;
  errorBySession: Record<string, string | null>;

  loadInitial(workspaceSlug: string, sessionId: string): Promise<void>;
  appendEvent(sessionId: string, ev: SessionEventDTO): void;
  setStatus(sessionId: string, status: ConnStatus): void;
  setError(sessionId: string, msg: string | null): void;
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
  maxSeqBySession: {},
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

      const maxSeq = res.events.reduce((m, e) => Math.max(m, e.seq), -1);
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
        maxSeqBySession: {
          ...s.maxSeqBySession,
          [sessionId]: maxSeq,
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

  appendEvent(sessionId, ev) {
    set((s) => {
      const curMax = s.maxSeqBySession[sessionId] ?? -1;
      if (ev.seq <= curMax) return s;
      const cur = s.eventsBySession[sessionId] ?? [];
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
      return {
        eventsBySession: {
          ...s.eventsBySession,
          [sessionId]: [...cur, ev],
        },
        maxSeqBySession: { ...s.maxSeqBySession, [sessionId]: ev.seq },
        sessionsById: sessions,
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
}));
