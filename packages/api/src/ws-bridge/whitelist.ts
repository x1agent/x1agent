// What the WS bridge is allowed to relay between browser and NATS.
//
// The browser used to talk to NATS directly over a public WebSocket
// where it was authenticated as the `x1agent-api` super-user — every
// subject, every workspace, every session, both directions. That hole
// is now closed at the ingress; this module is the new gate.
//
// Two rules govern every message that flows through the bridge:
//
//   1. Subject allow-list. The browser may only sub/pub to the four
//      subject *kinds* enumerated here. Everything else (sidecar
//      request/reply, provider RPC, image build, internal routing,
//      JetStream inboxes) is unreachable from a browser session.
//
//   2. Payload whitelist. For each allowed subject the bridge keeps
//      only fields the browser actually renders, and recursively
//      scrubs anything whose key name looks like a credential
//      (`token`, `api_key`, `secret`, `password`, `credential`,
//      `authorization`). Belt-and-braces against a future publisher
//      forgetting to redact.
//
// If you're adding a new event type or new field the browser needs,
// add it here FIRST and bump the per-type whitelist; don't widen the
// catch-alls. The contract: this file is the single source of truth
// for "what the browser can see / send".

/**
 * Top-level event types the bridge relays from `x1.session.{id}.events`
 * to the browser. Everything outside this set is dropped silently so
 * an accidental new event type can't smuggle data out without a code
 * review here.
 */
export const ALLOWED_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  // User input echoed by the agent's SSE stream after the sidecar
  // forwards it.
  "user.message",
  "user.input_response",
  // Agent emissions.
  "agent.text",
  "agent.artifact",
  "agent.share",
  "agent.status",
  "agent.input_request",
  "agent.permission_request",
  "agent.tool_call",
  "agent.tool_result",
  "agent.tool_error",
  "agent.error",
  "agent.usage",
  // Session lifecycle.
  "session.init",
  "session.started",
  "session.resumed",
  "session.completed",
  "session.failed",
  // Transient indicators (X1A-103/104). Not persisted; render only.
  "session.agent_thinking",
  "session.agent_thinking_cancelled",
  // Forward-compat sentinel emitted by older agents when a new event
  // type lands in the SDK ahead of the sidecar's parser.
  "agent.unknown_future_type",
]);

/**
 * Substrings that, if present in any object KEY anywhere in a payload
 * tree, mark that key for redaction before the message reaches the
 * browser. Compared case-insensitively. The redacted value is replaced
 * with the literal string `"[REDACTED]"` (not deleted) so the browser
 * can still see that the field existed for debugging.
 *
 * This is the defense-in-depth layer. The primary control is that
 * publishers must never include these fields in the first place. If
 * this catch ever fires in production, that's an upstream bug.
 */
const SENSITIVE_KEY_NEEDLES: readonly string[] = [
  "api_key",
  "apikey",
  "secret",
  "password",
  "credential",
  "credentials",
  "authorization",
  // `token` is broad enough to catch `access_token`, `refresh_token`,
  // `installation_token`, `bearer_token`. False positives like
  // `cancellation_token` or `csrf_token` get redacted too — acceptable
  // because neither is something the browser needs to read from a
  // session event payload.
  "token",
  // Long-form aliases for the same.
  "private_key",
  "client_secret",
];

function looksSensitive(key: string): boolean {
  const k = key.toLowerCase();
  for (const needle of SENSITIVE_KEY_NEEDLES) {
    if (k.includes(needle)) return true;
  }
  return false;
}

/**
 * Recursively walk an object/array and replace values at keys whose
 * names look like credentials with `"[REDACTED]"`. Returns a new
 * value; the input is not mutated.
 *
 * Cap recursion at depth 8 so a deliberately deep payload from a
 * compromised publisher can't lock the bridge with stack exhaustion.
 * Anything past depth 8 is replaced with `"[TRUNCATED]"`.
 */
export function scrubSensitiveKeys(input: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) {
    return input.map((v) => scrubSensitiveKeys(v, depth + 1));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (looksSensitive(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = scrubSensitiveKeys(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

export interface RawSessionEvent {
  session_id?: unknown;
  sequence?: unknown;
  type?: unknown;
  payload?: unknown;
  timestamp?: unknown;
}

export interface SessionEventForBrowser {
  session_id: string;
  sequence: number;
  type: string;
  payload: unknown;
  timestamp: string;
}

/**
 * Validate that a NATS message decoded from `x1.session.{id}.events`
 * matches the shape the browser expects AND is in the allow-list of
 * event types. Returns the normalised object (with sensitive keys
 * scrubbed) or null if the message must be dropped.
 *
 * The bridge calls this per message; failures are silent — the
 * browser shouldn't be able to distinguish "malformed event" from
 * "no event" because publishers might legitimately emit a future
 * type the browser will catch up to later.
 */
export function filterSessionEvent(
  expectedSessionId: string,
  raw: RawSessionEvent,
): SessionEventForBrowser | null {
  if (typeof raw.session_id !== "string") return null;
  if (raw.session_id !== expectedSessionId) {
    // Sidecar should never publish to a subject that doesn't match
    // the body's session_id, but if it does we drop rather than let
    // a cross-session leak slip through.
    return null;
  }
  if (typeof raw.sequence !== "number" && typeof raw.sequence !== "string") {
    return null;
  }
  if (typeof raw.type !== "string") return null;
  if (!ALLOWED_SESSION_EVENT_TYPES.has(raw.type)) return null;
  if (typeof raw.timestamp !== "string") return null;
  const seq =
    typeof raw.sequence === "number" ? raw.sequence : Number(raw.sequence);
  if (!Number.isFinite(seq)) return null;
  return {
    session_id: raw.session_id,
    sequence: seq,
    type: raw.type,
    payload: scrubSensitiveKeys(raw.payload),
    timestamp: raw.timestamp,
  };
}

export interface RawCommentEvent {
  // From comment-publisher: share_id / thread_id / comment_id are
  // always present; the rest are best-effort.
  share_id?: unknown;
  thread_id?: unknown;
  comment_id?: unknown;
  actor_user_id?: unknown;
  actor_session_id?: unknown;
  comment_scope?: unknown;
  anchor?: unknown;
  comment_body?: unknown;
  workspace_id?: unknown;
  session_id?: unknown;
  share_type?: unknown;
  parent_comment_id?: unknown;
  // Resolved-thread variants.
  transitioned_at?: unknown;
  resolved?: unknown;
  resolved_by_user_id?: unknown;
  // Routing/internal fields — DROPPED by the bridge below.
  producing_session_id?: unknown;
  producing_agent_id?: unknown;
}

export interface CommentEventForBrowser {
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
  transitioned_at: string | null;
  resolved: boolean | null;
  resolved_by_user_id: string | null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Validate + filter a share-comment NATS message before relaying it
 * to a connected browser. Drops internal routing fields
 * (producing_session_id, producing_agent_id) and rejects messages
 * missing the three identifiers the browser dedupes on.
 *
 * The bridge calls this AFTER a separate authorization step has
 * verified the message's `workspace_id` is one the connected user
 * belongs to (or it's a global subject the user is allowed on).
 */
export function filterCommentEvent(
  raw: RawCommentEvent,
): CommentEventForBrowser | null {
  if (typeof raw.share_id !== "string") return null;
  if (typeof raw.thread_id !== "string") return null;
  if (typeof raw.comment_id !== "string") return null;
  return {
    share_id: raw.share_id,
    thread_id: raw.thread_id,
    comment_id: raw.comment_id,
    actor_user_id: asStringOrNull(raw.actor_user_id),
    actor_session_id: asStringOrNull(raw.actor_session_id),
    comment_scope: asStringOrNull(raw.comment_scope),
    anchor: scrubSensitiveKeys(raw.anchor),
    comment_body:
      typeof raw.comment_body === "string" ? raw.comment_body : null,
    workspace_id: asStringOrNull(raw.workspace_id),
    session_id: asStringOrNull(raw.session_id),
    share_type: asStringOrNull(raw.share_type),
    parent_comment_id: asStringOrNull(raw.parent_comment_id),
    transitioned_at: asStringOrNull(raw.transitioned_at),
    resolved:
      typeof raw.resolved === "boolean" ? raw.resolved : null,
    resolved_by_user_id: asStringOrNull(raw.resolved_by_user_id),
  };
}

/**
 * The browser can only publish two subject kinds back to NATS via the
 * bridge:
 *
 *   - `session_input` → `x1.session.{id}.input` (JetStream, dedup by msgID)
 *   - `session_presence` → `x1.session.{id}.presence` (NATS core, fire-and-forget)
 *
 * Anything else from the client is rejected at the dispatch site, not
 * here — this enum exists so the dispatch site has a single set to
 * switch on.
 */
export type ClientPublishKind = "session_input" | "session_presence";

export const CLIENT_PUBLISH_KINDS: ReadonlySet<ClientPublishKind> = new Set([
  "session_input",
  "session_presence",
]);

/**
 * Cap on the JSON size of a single `session_input` envelope from the
 * browser. The composer hard-caps at ~32KB today; 100KB is the
 * comfort margin. Anything larger is rejected at the bridge — same
 * answer the agent would give if a 1MB blob made it through.
 */
export const MAX_INPUT_ENVELOPE_BYTES = 100 * 1024;

/**
 * Cap on JetStream input message age. A client envelope must include
 * `expires_at` (epoch ms) within this window of `Date.now()` at the
 * bridge. Protects against a captured-in-transit envelope being
 * replayed hours later.
 */
export const INPUT_ENVELOPE_MAX_AGE_MS = 5 * 60 * 1000;
