import { create } from "zustand";
import type {
  SessionDTO,
  SessionEventDTO,
  SessionEventListResponse,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

type ConnStatus = "connecting" | "live" | "ended" | "error";

interface SessionDetailState {
  sessionsById: Record<string, SessionDTO>;
  agentsBySession: Record<
    string,
    { id: string; slug: string; name: string }
  >;
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
      const maxSeq = res.events.reduce((m, e) => Math.max(m, e.seq), -1);
      set((s) => ({
        sessionsById: { ...s.sessionsById, [sessionId]: res.session },
        agentsBySession: { ...s.agentsBySession, [sessionId]: res.agent },
        eventsBySession: { ...s.eventsBySession, [sessionId]: res.events },
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
