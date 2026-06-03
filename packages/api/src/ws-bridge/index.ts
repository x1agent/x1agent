// WebSocket bridge between the browser and NATS.
//
// Before this module existed, the browser opened a public WebSocket
// directly to the NATS server and was authenticated as the
// `x1agent-api` super-user with cluster-wide pub/sub permissions on
// every subject. Anyone who could reach `wss://nats.<base-domain>`
// could exfiltrate every session event, every comment, every share
// notification across every workspace, or publish forged events.
//
// The fix is to:
//
//   - Delete the public NATS Ingress (see deploy/helm/x1agent/...).
//   - Lock the NATS Service to in-cluster traffic (NetworkPolicy).
//   - Route the browser through this bridge over `wss://api.<base>/api/ws`.
//
// What the bridge does on every WS message:
//
//   1. Reject any subject/op the browser isn't on the allow-list for
//      (see whitelist.ts).
//   2. Authorize subscriptions per-session using the same
//      `resolveSessionVisibility` primitive the REST routes use.
//   3. Authorize publishes (session input + presence) as owner-only.
//      A share recipient can comment on a session via the REST API,
//      but they cannot inject new turns via the WS.
//   4. Filter inbound NATS messages through the whitelist before
//      relaying — drops unknown event types, scrubs payload fields
//      whose keys look like credentials.
//   5. For the cluster-wide `agent.share_comment_*` subjects, enforce
//      per-workspace scoping: only relay messages whose `workspace_id`
//      is one this user is a member of. Closes the cross-tenant comment
//      leak that the direct-NATS exposure also had.

import {
  StringCodec,
  type NatsConnection,
  type Subscription,
} from "nats";
import type { ServerWebSocket } from "bun";
import type { AuthSession, SessionTokenizer } from "@x1agent/domain-auth";
import type { UserId, WorkspaceId } from "@x1agent/kernel";
import {
  SessionId,
  resolveSessionVisibility,
  type PostgresSessionRepository,
  type PostgresSessionShareRepository,
  type PlatformAdminGuard,
} from "@x1agent/domain-sessions";
import type { PostgresAgentRepository } from "@x1agent/domain-agents";
import type { PostgresMembershipRepository } from "@x1agent/domain-workspaces";
import { WorkspaceAdminGuard } from "../composition/invitation-adapters.js";
import {
  filterSessionEvent,
  filterCommentEvent,
  INPUT_ENVELOPE_MAX_AGE_MS,
  MAX_INPUT_ENVELOPE_BYTES,
  type CommentEventForBrowser,
} from "./whitelist.js";

const WS_PATH = "/api/ws";

/**
 * Pure decision for "may this actor publish turns into this session?"
 * Extracted from the WS bridge so the policy is testable in isolation
 * — the bridge does the I/O (sessions.findById) and hands the loaded
 * row here.
 *
 * Session-actor isolation: only the user who triggered the session
 * may publish into it. Any other workspace member — even one with
 * `collaborate` grants or an open-by-default workspace agent — gets
 * `not_session_owner` here.
 *
 * Why publish is stricter than view: the agent pod binds
 * remote_oauth credentials at session-launch keyed by the triggering
 * user's `user_mcp_tokens`. A second user sending turns would have
 * the agent act on those upstream services AS the triggerer —
 * triggerer's connection, scopes, and audit trail. That's an
 * authentication-context confusion, not collaboration. View remains
 * workspace-wide so teammates can still watch a session unfold;
 * publish is per-actor.
 *
 * Future: a per-agent `allow_publish_by_collaborators` flag with a
 * strict default would unlock multi-driver flows where the actor
 * model is explicit. Until then every session has exactly one
 * driver.
 */
export function decideSessionPublish(input: {
  session: { triggeredByUserId: string | null } | null;
  actor: UserId;
}): { ok: true } | { ok: false; code: string } {
  if (!input.session) return { ok: false, code: "not_found" };
  if (input.session.triggeredByUserId !== input.actor) {
    return { ok: false, code: "not_session_owner" };
  }
  return { ok: true };
}

export interface WsBridgeDeps {
  tokenizer: SessionTokenizer;
  nats: NatsConnection;
  sessions: PostgresSessionRepository;
  agents: PostgresAgentRepository;
  memberships: PostgresMembershipRepository;
  sessionShares: PostgresSessionShareRepository;
  /** Platform-admin bypass for session visibility. Optional. */
  platformAdminGuard?: PlatformAdminGuard;
  /**
   * Optional resolver — returns true when the actor has `collaborate`
   * access on the named agent. Wired by the composition root from
   * `resolveAgentAccess`. Powers the open-by-default policy: workspace
   * members of a `visibility='workspace'` agent can view AND publish
   * to every session that agent ever runs, including resumed ones.
   * Without this wired, the bridge falls back to owner-only publish
   * + share-recipient read.
   */
  agentCollaborateResolver?: (
    actor: UserId,
    agentId: string,
  ) => Promise<boolean>;
  cookieName?: string;
}

type SubKey = string;

interface WsState {
  actor: AuthSession;
  // Cache of resolved workspace IDs the user is a member of. Populated
  // lazily on the first `sub_comments` request; the comment-relay
  // filter consults this set on every inbound message, so we keep it
  // in memory rather than re-querying Postgres per message.
  workspaceIds: Set<string> | null;
  // Active NATS subscriptions held open for this connection. Keyed by
  // a logical identifier the client doesn't see (we only support one
  // session subscription + one comments subscription per connection,
  // matching the browser's current usage).
  subs: Map<SubKey, Subscription>;
  // Set once the comments subscription is active so a second
  // `sub_comments` request is a no-op rather than opening duplicate
  // NATS subs.
  commentsSubActive: boolean;
}

const sc = StringCodec();

/**
 * Decide whether a request hitting the api should be hijacked by the
 * bridge instead of routed through Hono. Match on path AND the
 * `Upgrade: websocket` header — a plain HTTP GET to /api/ws is left
 * for Hono to 404.
 */
export function isWsBridgeRequest(req: Request): boolean {
  const url = new URL(req.url);
  if (url.pathname !== WS_PATH) return false;
  const upgrade = req.headers.get("upgrade")?.toLowerCase();
  return upgrade === "websocket";
}

/**
 * Pull the session JWT out of the upgrade request. Mirrors
 * createRequireAuth: cookie first, Authorization header as the
 * fallback path used by tooling.
 */
function extractToken(req: Request, cookieName: string): string | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  if (match?.[1]) return match[1];
  const auth = req.headers.get("authorization");
  if (auth) return auth.replace(/^Bearer\s+/i, "");
  // EventSource and some browser test harnesses can't set custom
  // headers on a WS upgrade. Allow `?access_token=` as an explicit
  // fallback. The token still has to verify, so this isn't a separate
  // auth surface — just a different transport for the same JWT.
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("access_token");
    return q || null;
  } catch {
    return null;
  }
}

/**
 * Authenticate the upgrade request. Returns the AuthSession if the
 * token is valid; returns a Response (401/400) otherwise so the
 * caller can short-circuit.
 */
export function authenticateUpgrade(
  req: Request,
  deps: WsBridgeDeps,
): { ok: true; actor: AuthSession } | { ok: false; response: Response } {
  const cookieName = deps.cookieName ?? "x1_session";
  const token = extractToken(req, cookieName);
  if (!token) {
    return { ok: false, response: new Response("unauthenticated", { status: 401 }) };
  }
  const actor = deps.tokenizer.verify(token);
  if (!actor) {
    return { ok: false, response: new Response("invalid_token", { status: 401 }) };
  }
  return { ok: true, actor };
}

/**
 * Build the Bun WebSocket handlers + a `tryUpgrade(req, server)`
 * function the api entrypoint can call before falling through to
 * Hono. Returning the handlers lets index.ts wire them into
 * `Bun.serve`'s `websocket` option in one place.
 */
export function buildWsBridge(deps: WsBridgeDeps) {
  const adminGuard = new WorkspaceAdminGuard(deps.memberships);

  function send(ws: ServerWebSocket<WsState>, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // socket already closed; ignore.
    }
  }

  async function loadWorkspaceIds(actor: UserId): Promise<Set<string>> {
    const rows = await deps.memberships.listByUser(actor);
    return new Set(rows.map((m) => m.workspaceId as unknown as string));
  }

  async function authorizeSessionView(
    actor: UserId,
    sessionId: string,
  ): Promise<
    | { ok: true; workspaceId: WorkspaceId }
    | { ok: false; code: string }
  > {
    const session = await deps.sessions.findById(SessionId(sessionId));
    if (!session) return { ok: false, code: "not_found" };
    const agent = await deps.agents.findById(session.agentId);
    if (!agent) return { ok: false, code: "not_found" };
    const decision = await resolveSessionVisibility(
      {
        adminGuard,
        platformAdminGuard: deps.platformAdminGuard,
        shares: deps.sessionShares,
        agentCollaborateResolver: deps.agentCollaborateResolver,
      },
      actor,
      session,
      agent.workspaceId,
    );
    if (!decision.visible) return { ok: false, code: "forbidden" };
    return { ok: true, workspaceId: agent.workspaceId };
  }

  async function authorizeSessionPublish(
    actor: UserId,
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const session = await deps.sessions.findById(SessionId(sessionId));
    return decideSessionPublish({ session, actor });
  }

  async function startSessionEventSub(
    ws: ServerWebSocket<WsState>,
    sessionId: string,
  ): Promise<void> {
    const subKey = `session:${sessionId}`;
    if (ws.data.subs.has(subKey)) {
      send(ws, { op: "sub_ack", kind: "session", session_id: sessionId });
      return;
    }
    const decision = await authorizeSessionView(ws.data.actor.userId, sessionId);
    if (!decision.ok) {
      send(ws, {
        op: "sub_err",
        kind: "session",
        session_id: sessionId,
        code: decision.code,
      });
      return;
    }
    const sub = deps.nats.subscribe(`x1.session.${sessionId}.events`);
    ws.data.subs.set(subKey, sub);
    send(ws, { op: "sub_ack", kind: "session", session_id: sessionId });
    (async () => {
      for await (const m of sub) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(sc.decode(m.data));
        } catch {
          continue;
        }
        const filtered = filterSessionEvent(
          sessionId,
          parsed as Record<string, unknown>,
        );
        if (!filtered) continue;
        send(ws, { op: "session_event", event: filtered });
      }
    })().catch(() => {
      // sub closed; nothing to do.
    });
  }

  async function startCommentsSub(
    ws: ServerWebSocket<WsState>,
  ): Promise<void> {
    if (ws.data.commentsSubActive) {
      send(ws, { op: "sub_ack", kind: "comments" });
      return;
    }
    if (!ws.data.workspaceIds) {
      ws.data.workspaceIds = await loadWorkspaceIds(ws.data.actor.userId);
    }
    const allowedWorkspaces = ws.data.workspaceIds;
    ws.data.commentsSubActive = true;
    send(ws, { op: "sub_ack", kind: "comments" });

    const wire = (kind: "added" | "resolved", data: CommentEventForBrowser) => {
      // Cross-tenant filter: drop any message whose workspace_id isn't
      // one this user belongs to. The publisher emits cluster-wide, so
      // without this every signed-in user would see every workspace's
      // comment traffic.
      if (data.workspace_id && !allowedWorkspaces.has(data.workspace_id)) {
        return;
      }
      send(ws, { op: "comment_event", kind, data });
    };

    const addedSub = deps.nats.subscribe("agent.share_comment_added");
    const resolvedSub = deps.nats.subscribe(
      "agent.share_comment_thread_resolved",
    );
    ws.data.subs.set("comments:added", addedSub);
    ws.data.subs.set("comments:resolved", resolvedSub);

    (async () => {
      for await (const m of addedSub) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(sc.decode(m.data));
        } catch {
          continue;
        }
        const filtered = filterCommentEvent(parsed as Record<string, unknown>);
        if (!filtered) continue;
        wire("added", filtered);
      }
    })().catch(() => {});

    (async () => {
      for await (const m of resolvedSub) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(sc.decode(m.data));
        } catch {
          continue;
        }
        const filtered = filterCommentEvent(parsed as Record<string, unknown>);
        if (!filtered) continue;
        wire("resolved", filtered);
      }
    })().catch(() => {});
  }

  async function handlePublishInput(
    ws: ServerWebSocket<WsState>,
    msg: {
      session_id?: unknown;
      envelope?: unknown;
      msg_id?: unknown;
    },
  ): Promise<void> {
    const sessionId = typeof msg.session_id === "string" ? msg.session_id : "";
    const msgId = typeof msg.msg_id === "string" ? msg.msg_id : "";
    if (!sessionId || !msgId) {
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: "invalid_request",
        message: "session_id and msg_id required",
      });
      return;
    }
    if (!msg.envelope || typeof msg.envelope !== "object") {
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: "invalid_request",
        message: "envelope required",
      });
      return;
    }
    const envBytes = Buffer.byteLength(JSON.stringify(msg.envelope), "utf8");
    if (envBytes > MAX_INPUT_ENVELOPE_BYTES) {
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: "too_large",
        message: `envelope ${envBytes} bytes > ${MAX_INPUT_ENVELOPE_BYTES}`,
      });
      return;
    }
    const expiresAt = (msg.envelope as { expires_at?: unknown }).expires_at;
    if (typeof expiresAt !== "number") {
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: "invalid_request",
        message: "envelope.expires_at required",
      });
      return;
    }
    const now = Date.now();
    if (expiresAt < now) {
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: "expired",
        message: "envelope already expired",
      });
      return;
    }
    if (expiresAt - now > INPUT_ENVELOPE_MAX_AGE_MS) {
      // Browser is publishing with a TTL further in the future than
      // the policy allows; reject rather than silently truncate.
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: "ttl_too_long",
        message: "envelope expires beyond policy",
      });
      return;
    }
    const auth = await authorizeSessionPublish(ws.data.actor.userId, sessionId);
    if (!auth.ok) {
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: auth.code,
        message: "publish denied",
      });
      return;
    }
    // Force-stamp session_id on the envelope so a client can't smuggle
    // a different session_id into the body while addressing the subject
    // for their own session.
    const safeEnvelope = {
      ...(msg.envelope as Record<string, unknown>),
      session_id: sessionId,
    };
    try {
      await deps.nats.jetstream().publish(
        `x1.session.${sessionId}.input`,
        sc.encode(JSON.stringify(safeEnvelope)),
        { msgID: msgId },
      );
      send(ws, { op: "pub_ack", msg_id: msgId });
    } catch (err) {
      send(ws, {
        op: "pub_err",
        msg_id: msgId,
        code: "publish_failed",
        message: (err as Error).message,
      });
    }
  }

  async function handlePublishPresence(
    ws: ServerWebSocket<WsState>,
    msg: { session_id?: unknown; payload?: unknown },
  ): Promise<void> {
    const sessionId = typeof msg.session_id === "string" ? msg.session_id : "";
    if (!sessionId) return; // presence is fire-and-forget; no error wire
    const auth = await authorizeSessionPublish(ws.data.actor.userId, sessionId);
    if (!auth.ok) return;
    const payload =
      msg.payload && typeof msg.payload === "object"
        ? (msg.payload as Record<string, unknown>)
        : { at: new Date().toISOString() };
    try {
      deps.nats.publish(
        `x1.session.${sessionId}.presence`,
        sc.encode(JSON.stringify(payload)),
      );
    } catch {
      // best-effort
    }
  }

  function closeSub(ws: ServerWebSocket<WsState>, key: SubKey): void {
    const sub = ws.data.subs.get(key);
    if (sub) {
      ws.data.subs.delete(key);
      void sub.unsubscribe();
    }
  }

  function closeAllSubs(ws: ServerWebSocket<WsState>): void {
    for (const [, sub] of ws.data.subs) {
      void sub.unsubscribe();
    }
    ws.data.subs.clear();
    ws.data.commentsSubActive = false;
  }

  const websocket = {
    open(ws: ServerWebSocket<WsState>) {
      send(ws, { op: "ready" });
    },
    async message(ws: ServerWebSocket<WsState>, data: string | Buffer) {
      let msg: { op?: unknown } & Record<string, unknown>;
      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        msg = JSON.parse(text) as { op?: unknown } & Record<string, unknown>;
      } catch {
        send(ws, { op: "err", code: "invalid_json" });
        return;
      }
      if (typeof msg.op !== "string") {
        send(ws, { op: "err", code: "missing_op" });
        return;
      }
      try {
        switch (msg.op) {
          case "ping":
            send(ws, { op: "pong" });
            return;
          case "sub_session": {
            const sid =
              typeof msg.session_id === "string" ? msg.session_id : "";
            if (!sid) {
              send(ws, { op: "err", code: "invalid_request" });
              return;
            }
            await startSessionEventSub(ws, sid);
            return;
          }
          case "unsub_session": {
            const sid =
              typeof msg.session_id === "string" ? msg.session_id : "";
            if (sid) closeSub(ws, `session:${sid}`);
            return;
          }
          case "sub_comments": {
            await startCommentsSub(ws);
            return;
          }
          case "pub_input": {
            await handlePublishInput(
              ws,
              msg as { session_id?: unknown; envelope?: unknown; msg_id?: unknown },
            );
            return;
          }
          case "pub_presence": {
            await handlePublishPresence(
              ws,
              msg as { session_id?: unknown; payload?: unknown },
            );
            return;
          }
          default:
            send(ws, { op: "err", code: "unknown_op" });
        }
      } catch (err) {
        send(ws, {
          op: "err",
          code: "internal",
          message: (err as Error).message,
        });
      }
    },
    close(ws: ServerWebSocket<WsState>) {
      closeAllSubs(ws);
    },
  };

  function tryUpgrade(
    req: Request,
    server: import("bun").Server<WsState>,
  ): Response | undefined {
    if (!isWsBridgeRequest(req)) return undefined;
    const auth = authenticateUpgrade(req, deps);
    if (!auth.ok) return auth.response;
    const upgraded = server.upgrade(req, {
      data: {
        actor: auth.actor,
        workspaceIds: null,
        subs: new Map(),
        commentsSubActive: false,
      },
    });
    if (upgraded) {
      // Bun swallowed the request; signal Hono not to handle it.
      return undefined;
    }
    return new Response("upgrade_failed", { status: 400 });
  }

  return { websocket, tryUpgrade };
}
