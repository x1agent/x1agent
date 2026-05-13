import type { UserId } from "@x1agent/kernel";
import type { AgentRepository } from "@x1agent/domain-agents";
import { AgentNotFoundError } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { SessionEventRepository } from "../ports/session-event-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import {
  SessionNotFoundError,
  type SessionId,
  type Session,
} from "../domain/session.js";
import { isShareCommentWakeEvent, type SessionEvent } from "../domain/event.js";

export interface ListSessionEventsDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  events: SessionEventRepository;
  adminGuard: AdminGuard;
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export interface ListSessionEventsResult {
  session: Session;
  events: readonly SessionEvent[];
}

export async function listSessionEvents(
  deps: ListSessionEventsDeps,
  actor: UserId,
  sessionId: SessionId,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<ListSessionEventsResult> {
  const session = await deps.sessions.findById(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  const agent = await deps.agents.findById(session.agentId);
  if (!agent) throw new AgentNotFoundError(session.agentId);
  await deps.adminGuard.assertAdmin(actor, agent.workspaceId);
  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));
  const events = await deps.events.listBySession(sessionId, {
    afterSeq: opts.afterSeq,
    limit,
  });
  // X1A-110 — share-comment wakes live in the share's comment flyout,
  // not the main session timeline. Server-side filter so a refresh /
  // first-load doesn't render them; the client also filters live
  // WS-arriving events via `compactKind` to cover the streaming path.
  const filtered = events.filter((e) => !isShareCommentWakeEvent(e));
  return { session, events: filtered };
}
