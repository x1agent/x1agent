// Thin WebSocket client for the api's `/api/ws` bridge.
//
// The browser used to connect to NATS directly over a public
// WebSocket (`wss://nats.<base-domain>`). That endpoint authenticated
// every client as the `x1agent-api` super-user with cluster-wide
// pub/sub — a P0 cross-tenant leak. The bridge in
// `packages/api/src/ws-bridge/` replaces that endpoint with an
// authenticated, per-workspace-scoped relay over an api-hosted WS.
//
// What this module is:
//
//   - A tiny JSON-envelope client. Connects to `<API_BASE>/api/ws`
//     with credentials included so the session cookie reaches the
//     upgrade handler.
//   - Re-exposes only the four operations the browser actually used
//     against NATS: subscribe to a session's events, subscribe to
//     cluster-wide comment notifications, publish session input,
//     publish session presence.
//   - Auto-reconnects with a capped backoff so a transient api
//     restart doesn't break live-update for the rest of the session.
//
// What this module is NOT:
//
//   - A full NATS protocol implementation. The bridge speaks a
//     small JSON envelope; everything else is filtered out
//     server-side. Don't add helpers for subjects the bridge
//     doesn't expose — go through `apiFetch` instead.

import { API_BASE } from "./api";

/**
 * Translate `http(s)://host/...` to `ws(s)://host/api/ws`. Drops any
 * path/query the API_BASE happens to carry — the bridge lives at a
 * fixed path on the api origin.
 */
function buildWsUrl(): string {
  const base = API_BASE.replace(/\/$/, "");
  const ws = base.replace(/^http(s?):/, "ws$1:");
  return `${ws}/api/ws`;
}

export interface BridgeSessionEvent {
  session_id: string;
  sequence: number;
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface BridgeCommentEvent {
  share_id: string;
  thread_id: string;
  comment_id: string;
  actor_user_id: string | null;
  actor_session_id: string | null;
  comment_scope: string | null;
  anchor: unknown;
  comment_body: string | null;
  workspace_id: string | null;
  session_id: string | null;
  share_type: string | null;
  parent_comment_id: string | null;
  /**
   * Server-stamped ISO 8601 created-at. May be null on payloads from
   * an older api version mid-deploy; callers fall back to client wall
   * clock in that case (the pre-fix behaviour).
   */
  created_at: string | null;
  transitioned_at: string | null;
  resolved: boolean | null;
  resolved_by_user_id: string | null;
}

export interface BridgeHandlers {
  onSessionEvent?: (ev: BridgeSessionEvent) => void;
  onCommentEvent?: (
    kind: "added" | "resolved",
    data: BridgeCommentEvent,
  ) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface SessionInputEnvelope {
  session_id: string;
  timestamp: string;
  sequence: number;
  type: string;
  expires_at: number;
  payload: Record<string, unknown>;
}

/**
 * Open a connection to the bridge. Returns a handle the caller uses
 * to subscribe + publish + close. The handle accepts subscription
 * requests immediately; the client queues them until the underlying
 * WebSocket opens, then ships them in order so the caller never has
 * to wait on a "connected" event.
 */
export function openBridge(handlers: BridgeHandlers): BridgeHandle {
  return new BridgeClient(handlers);
}

export interface BridgeHandle {
  subscribeSession(sessionId: string): void;
  unsubscribeSession(sessionId: string): void;
  subscribeComments(): void;
  publishInput(envelope: SessionInputEnvelope, msgId: string): Promise<void>;
  publishPresence(sessionId: string, payload?: Record<string, unknown>): void;
  close(): void;
}

interface PendingInputAck {
  resolve: () => void;
  reject: (err: Error) => void;
  // Reject any publish whose ack doesn't arrive within this window
  // so the composer can render a "Send failed — retry" instead of
  // hanging forever on a stuck connection.
  timer: ReturnType<typeof setTimeout>;
}

const PUBLISH_ACK_TIMEOUT_MS = 15_000;

class BridgeClient implements BridgeHandle {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelayMs = 500;
  private queue: string[] = [];
  // Re-applied automatically after a reconnect so the caller's
  // subscriptions survive transient drops.
  private sessionSubs = new Set<string>();
  private commentsActive = false;
  private inputAcks = new Map<string, PendingInputAck>();

  constructor(private readonly handlers: BridgeHandlers) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    try {
      const url = buildWsUrl();
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.reconnectDelayMs = 500;
        // Re-issue every active subscription. The server treats
        // duplicate subscribes as no-ops, so this is safe even if
        // the previous connection's subs hadn't been torn down yet.
        for (const sid of this.sessionSubs) {
          this.sendRaw({ op: "sub_session", session_id: sid });
        }
        if (this.commentsActive) {
          this.sendRaw({ op: "sub_comments" });
        }
        // Flush anything the caller submitted before we connected.
        const queued = this.queue.splice(0);
        for (const msg of queued) ws.send(msg);
        this.handlers.onOpen?.();
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        let msg: { op?: string } & Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data as string) as typeof msg;
        } catch {
          return;
        }
        this.dispatch(msg);
      });
      ws.addEventListener("close", () => {
        this.handlers.onClose?.();
        this.scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        // 'close' is fired right after 'error' for WebSocket; let
        // that handler do the reconnect bookkeeping.
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(this.reconnectDelayMs, 10_000);
    setTimeout(() => this.connect(), delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
  }

  private dispatch(msg: { op?: string } & Record<string, unknown>): void {
    switch (msg.op) {
      case "session_event": {
        const ev = msg.event as BridgeSessionEvent | undefined;
        if (ev) this.handlers.onSessionEvent?.(ev);
        return;
      }
      case "comment_event": {
        const data = msg.data as BridgeCommentEvent | undefined;
        const kind = msg.kind === "resolved" ? "resolved" : "added";
        if (data) this.handlers.onCommentEvent?.(kind, data);
        return;
      }
      case "pub_ack": {
        const id = typeof msg.msg_id === "string" ? msg.msg_id : "";
        const pending = this.inputAcks.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve();
          this.inputAcks.delete(id);
        }
        return;
      }
      case "pub_err": {
        const id = typeof msg.msg_id === "string" ? msg.msg_id : "";
        const pending = this.inputAcks.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(
            new Error(
              typeof msg.message === "string"
                ? msg.message
                : (msg.code as string) ?? "publish_failed",
            ),
          );
          this.inputAcks.delete(id);
        }
        return;
      }
      default:
        // sub_ack, sub_err, ready, pong — no client-side observers today.
        return;
    }
  }

  private sendRaw(obj: unknown): void {
    const text = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    } else {
      this.queue.push(text);
    }
  }

  subscribeSession(sessionId: string): void {
    if (this.sessionSubs.has(sessionId)) return;
    this.sessionSubs.add(sessionId);
    this.sendRaw({ op: "sub_session", session_id: sessionId });
  }

  unsubscribeSession(sessionId: string): void {
    if (!this.sessionSubs.has(sessionId)) return;
    this.sessionSubs.delete(sessionId);
    this.sendRaw({ op: "unsub_session", session_id: sessionId });
  }

  subscribeComments(): void {
    if (this.commentsActive) return;
    this.commentsActive = true;
    this.sendRaw({ op: "sub_comments" });
  }

  publishInput(envelope: SessionInputEnvelope, msgId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inputAcks.delete(msgId);
        reject(new Error("publish timeout"));
      }, PUBLISH_ACK_TIMEOUT_MS);
      this.inputAcks.set(msgId, { resolve, reject, timer });
      this.sendRaw({
        op: "pub_input",
        session_id: envelope.session_id,
        envelope,
        msg_id: msgId,
      });
    });
  }

  publishPresence(sessionId: string, payload?: Record<string, unknown>): void {
    this.sendRaw({
      op: "pub_presence",
      session_id: sessionId,
      payload: payload ?? { at: new Date().toISOString() },
    });
  }

  close(): void {
    this.closed = true;
    // Fail any outstanding publish promises so the composer doesn't
    // hang on a send issued at unmount time.
    for (const [, pending] of this.inputAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error("bridge closed"));
    }
    this.inputAcks.clear();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}
