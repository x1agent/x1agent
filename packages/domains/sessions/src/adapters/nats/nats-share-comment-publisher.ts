import type {
  ShareCommentAddedEvent,
  ShareCommentPublisher,
  ShareCommentThreadResolvedEvent,
} from "../../ports/share-comment-publisher.js";

/**
 * Thin shape for the platform's NATS publisher — keeps this adapter
 * decoupled from any specific NATS client. The api wires this with its
 * existing `nats.publish` plumbing; tests substitute an in-memory
 * recorder. Subjects + payload shape are stable contracts because
 * X1A-55 subscribes to them.
 *
 * Canonical subjects (X1A-52 ticket body):
 *   - agent.share_comment_added
 *   - agent.share_comment_thread_resolved
 *
 * Both payloads carry `producing_session_id` + `producing_agent_id`
 * (CEO 2026-05-12 hard requirement) so X1A-55's comment-handler can
 * spawn the right agent of the right session without re-querying the DB.
 */
export interface NatsPublishPort {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export const SUBJECT_COMMENT_ADDED = "agent.share_comment_added";
export const SUBJECT_THREAD_RESOLVED = "agent.share_comment_thread_resolved";

export class NatsShareCommentPublisher implements ShareCommentPublisher {
  constructor(private readonly nats: NatsPublishPort) {}

  async commentAdded(e: ShareCommentAddedEvent): Promise<void> {
    await this.nats.publish(SUBJECT_COMMENT_ADDED, {
      share_id: e.shareId,
      thread_id: e.threadId,
      comment_id: e.commentId,
      actor_user_id: e.actorUserId,
      actor_session_id: e.actorSessionId,
      // X1A-55's wake router reads these two — DO NOT remove. Adding
      // an `actor_id` alias for parity with non-x1agent NATS subscribers
      // that already use the generic name.
      actor_id: e.actorUserId ?? e.actorSessionId,
      workspace_id: e.workspaceId,
      session_id: e.sessionId,
      share_type: e.shareType,
      comment_scope: e.commentScope,
      anchor: e.anchor,
      comment_body: e.body,
      producing_session_id: e.producingSessionId,
      producing_agent_id: e.producingAgentId,
      // X1A-110 — carried so the browser's live subscriber can
      // render a reply indented under the right parent without
      // waiting for a REST refresh. Null for a top-level comment.
      parent_comment_id: e.parentCommentId,
      // Server-stamped insertion time. Without this the browser fell
      // back to client wall-clock at NATS receipt, which drifts vs
      // REST-served rows (server clock) and broke thread ordering.
      created_at: e.createdAt.toISOString(),
    });
  }

  async threadResolved(e: ShareCommentThreadResolvedEvent): Promise<void> {
    await this.nats.publish(SUBJECT_THREAD_RESOLVED, {
      share_id: e.shareId,
      thread_id: e.threadId,
      resolved_by_user_id: e.resolvedByUserId,
      resolved: e.resolved,
      workspace_id: e.workspaceId,
      session_id: e.sessionId,
      share_type: e.shareType,
      transitioned_at: e.transitionedAt.toISOString(),
      producing_session_id: e.producingSessionId,
      producing_agent_id: e.producingAgentId,
    });
  }
}

/**
 * In-memory recorder used by tests + as the default no-op publisher
 * when NATS isn't wired (e.g. local dev without a broker).
 */
export class RecordingShareCommentPublisher implements ShareCommentPublisher {
  public readonly added: ShareCommentAddedEvent[] = [];
  public readonly resolved: ShareCommentThreadResolvedEvent[] = [];

  async commentAdded(e: ShareCommentAddedEvent): Promise<void> {
    this.added.push(e);
  }

  async threadResolved(e: ShareCommentThreadResolvedEvent): Promise<void> {
    this.resolved.push(e);
  }
}
