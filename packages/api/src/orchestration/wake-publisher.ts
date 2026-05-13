import { createHash } from "node:crypto";
import { StringCodec, type NatsConnection } from "nats";
import {
  type Session,
  type SessionRepository,
} from "@x1agent/domain-sessions";
import type { AgentRepository, AgentId } from "@x1agent/domain-agents";
import { isOrchestratorKind } from "@x1agent/domain-agents";

/**
 * One choke-point for every `x1.session.{id}.input` publish in this
 * module. When `USE_JETSTREAM_PUBLISH=true` the message goes through a
 * JetStream-aware publish that waits for an ACK from the server and
 * carries an Nats-Msg-Id header for dedup; otherwise it's the legacy
 * NATS-core publish (fire-and-forget). Every call site supplies a
 * deterministic msg-id so the JetStream stream's duplicate window
 * absorbs publisher-side retries and double-fires from racing watchers
 * without injecting the same wake into the orchestrator twice.
 *
 * The two paths coexist so the cutover can happen one publisher and
 * one consumer at a time. See rfcs/jetstream-migration.md.
 */
async function publishInputEnvelope(
  nc: NatsConnection,
  sessionId: string,
  envelope: object,
  msgId: string,
): Promise<void> {
  const subject = `x1.session.${sessionId}.input`;
  const sc = StringCodec();
  const data = sc.encode(JSON.stringify(envelope));
  if (process.env.USE_JETSTREAM_PUBLISH === "true") {
    await nc.jetstream().publish(subject, data, { msgID: msgId });
    return;
  }
  nc.publish(subject, data);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Platform → orchestrator wake publisher.
 *
 * When something happens that warrants reasoning from a parent
 * orchestrator, we inject a `user.message` into the parent's session
 * via NATS. The parent's sidecar picks it up on
 * `x1.session.{parent_id}.input` and POSTs it to the agent's /inject
 * endpoint, where it's processed on the next turn like any other user
 * message.
 *
 * Five wake kinds are specified in
 * docs/architecture/orchestration.md § Server-driven wakes:
 *   message       — child emitted agent.message_to_caller
 *   state_change  — child's sessions.status transitioned to terminal
 *   watchdog      — child silent beyond activity_timeout_seconds
 *   checkup       — cadence timer, regardless of child activity
 *   heartbeat     — scheduler tick for this orchestrator
 *
 * This module currently implements `state_change`. Additional kinds
 * land as separate commits when their watchers are implemented.
 *
 * The wake payload cannot carry structured metadata through to the
 * agent because the sidecar only forwards `text` (plus request_id /
 * sender_id) — see packages/sidecar/src/channel.rs. So the wake
 * kind and context are encoded into the `text` string itself. The
 * structured fields on the payload are preserved on the durable
 * session_events row so the UI can render wake-origin differently
 * from a human-typed message.
 */
export interface WakePublisherDeps {
  nc: NatsConnection;
  sessions: SessionRepository;
  agents: AgentRepository;
}

/**
 * Called after a session transitions to a terminal state
 * (`complete` or `failed`). If the session was spawned by an
 * orchestrator parent AND that parent is still alive, injects a
 * `state_change` wake into the parent. Silent in every other case.
 *
 * Guards (all required — each addresses a specific failure mode):
 *   1. childSession.parentSessionId is set
 *      (child was spawned by an agent, not a human)
 *   2. Parent session exists and is not itself terminal
 *      (don't wake a dead orchestrator)
 *   3. Parent agent exists and kind === 'orchestrator'
 *      (workers don't get wakes; they run one-shot)
 */
export async function publishStateChangeWake(
  deps: WakePublisherDeps,
  childSession: Session,
  terminalStatus: "complete" | "failed",
  completedAt: Date,
  errorMessage: string | null,
): Promise<void> {
  if (!childSession.parentSessionId) return;

  const parent = await deps.sessions.findById(childSession.parentSessionId);
  if (!parent) return;
  if (parent.status === "complete" || parent.status === "failed") return;

  const parentAgent = await deps.agents.findById(parent.agentId as AgentId);
  if (!parentAgent) return;
  if (!isOrchestratorKind(parentAgent.kind)) return;

  const childAgent = await deps.agents.findById(childSession.agentId as AgentId);
  const childSlug = childAgent?.slug ?? "<unknown>";

  const text = formatStateChangeWakeText({
    childSessionId: childSession.id,
    childSlug: String(childSlug),
    terminalStatus,
    completedAt,
    errorMessage,
  });

  // X1A-103: stamp an event_id on every server-published wake so the
  // agent's `session.agent_thinking` event can carry it through to
  // the UI for deterministic indicator-clearing. The msgId is
  // already deterministic per-wake (and is what JetStream uses for
  // dedup); reusing it as event_id keeps a single id flowing from
  // publisher → sidecar → agent → frontend.
  const msgId = `wake.state_change.${childSession.id}.${terminalStatus}`;
  const envelope = {
    session_id: parent.id,
    timestamp: new Date().toISOString(),
    type: "user.message",
    payload: {
      text,
      // Extra metadata the UI can render differently from a human
      // message. The sidecar drops everything except `text` when
      // forwarding to the agent, but the api persists the full
      // payload to session_events.
      kind: "state_change",
      event_id: msgId,
      from_session_id: childSession.id,
      from_agent_slug: String(childSlug),
      new_status: terminalStatus,
      completed_at: completedAt.toISOString(),
      error_message: errorMessage,
      driverless: true,
      source: "platform",
    },
  };

  // A child only transitions into each terminal state once, so the
  // (childSessionId, status) tuple is enough to dedup any duplicate
  // fire from a racing terminal-state watcher.
  await publishInputEnvelope(deps.nc, parent.id, envelope, msgId);
}

/**
 * Platform → orchestrator watchdog wake. Fires when a child session
 * has been silent (no new events) for longer than the configured
 * threshold. Carries the child session id, slug, and the observed
 * silence duration so the orchestrator can decide whether to
 * investigate, wait longer, or cancel.
 *
 * The activity watchdog (see activity-watchdog.ts) applies
 * exponential backoff per child so a truly stuck child doesn't
 * generate wake spam.
 */
export async function publishWatchdogWake(
  nc: import("nats").NatsConnection,
  parentSessionId: string,
  childSessionId: string,
  childSlug: string,
  silenceSeconds: number,
  attempt: number,
): Promise<void> {
  // X1A-103: msgId doubles as event_id (see publishStateChangeWake).
  const msgId = `wake.watchdog.${parentSessionId}.${childSessionId}.${attempt}`;
  const envelope = {
    session_id: parentSessionId,
    timestamp: new Date().toISOString(),
    type: "user.message",
    payload: {
      text: formatWatchdogWakeText({
        childSessionId,
        childSlug,
        silenceSeconds,
        attempt,
      }),
      kind: "watchdog",
      event_id: msgId,
      from_session_id: childSessionId,
      from_agent_slug: childSlug,
      silence_seconds: silenceSeconds,
      attempt,
      driverless: true,
      source: "platform",
    },
  };
  // attempt is monotonic per (parent, child); two publishes for the
  // same attempt are publisher-side retries that should dedup.
  await publishInputEnvelope(nc, parentSessionId, envelope, msgId);
}

/**
 * Child → orchestrator explicit message. Fires when a child calls
 * the `message_caller` MCP tool to push a signal to its parent.
 * Distinct from the other wake kinds — this one is initiated by
 * the child, not by a server-side watcher — but it flows through
 * the same `x1.session.<parent>.input` publish path.
 */
export async function publishMessageWake(
  nc: import("nats").NatsConnection,
  parentSessionId: string,
  opts: {
    childSessionId: string;
    childSlug: string;
    summary: string;
    body: string | null;
    needsResponse: boolean;
  },
): Promise<void> {
  const envelope = {
    session_id: parentSessionId,
    timestamp: new Date().toISOString(),
    type: "user.message",
    payload: {
      text: formatMessageWakeText(opts),
      kind: "message",
      // X1A-103: stamp event_id below once msgId is computed.
      from_session_id: opts.childSessionId,
      from_agent_slug: opts.childSlug,
      summary: opts.summary,
      body: opts.body,
      needs_response: opts.needsResponse,
      driverless: true,
      source: "platform",
    } as Record<string, unknown>,
  };
  // The child has no nominal request id at this layer; hashing the
  // payload makes a publisher retry of an identical message dedup,
  // while a child sending the same summary+body twice on purpose
  // (rare, and almost certainly a bug) is also collapsed -- which
  // is the right side to err on for a 2-minute window.
  const msgId =
    "wake.message." +
    sha256Hex(
      [
        opts.childSessionId,
        opts.summary,
        opts.body ?? "",
        opts.needsResponse ? "1" : "0",
      ].join(" "),
    );
  // X1A-103: msgId doubles as event_id so the agent_thinking
  // indicator clears against the same id the publisher uses for dedup.
  envelope.payload.event_id = msgId;
  await publishInputEnvelope(nc, parentSessionId, envelope, msgId);
}

export function formatMessageWakeText(opts: {
  childSessionId: string;
  childSlug: string;
  summary: string;
  body: string | null;
  needsResponse: boolean;
}): string {
  const shortId = opts.childSessionId.slice(0, 8);
  const lines = [
    `[driverless wake: message from child ${opts.childSlug}]`,
    "",
    `Child session ${shortId} (${opts.childSlug}) pushed a signal:`,
    "",
    `  "${opts.summary}"`,
  ];
  if (opts.body) {
    lines.push("", opts.body);
  }
  if (opts.needsResponse) {
    lines.push("", "needs_response: true");
  }
  lines.push("", "No human is watching — do not ask clarifying questions.");
  return lines.join("\n");
}

/**
 * Platform → orchestrator checkup wake. Cadence-driven "just
 * checking in" with a lightweight snapshot of all the
 * orchestrator's active children. Complementary to watchdog
 * (which is per-child silent-detection): checkup gives the
 * orchestrator periodic glance-opportunities even when every
 * child is happily emitting events and no watchdog would fire.
 *
 * The snapshot is rendered inline in the wake text so the agent
 * doesn't have to call read_child_output on each — most checkups
 * end with "looks fine, end turn" after one glance.
 */
export interface ChildSnapshot {
  sessionId: string;
  agentSlug: string;
  status: "pending" | "running";
  secondsSinceLastEvent: number;
  lastStatus: string | null;
}

export async function publishCheckupWake(
  nc: import("nats").NatsConnection,
  parentSessionId: string,
  snapshot: readonly ChildSnapshot[],
): Promise<void> {
  const timestamp = new Date().toISOString();
  // Checkup is cadence-driven; the wall-clock at publish time is the
  // natural dedup key. A retry of the same tick reuses this id.
  const msgId = `wake.checkup.${parentSessionId}.${timestamp}`;
  const envelope = {
    session_id: parentSessionId,
    timestamp,
    type: "user.message",
    payload: {
      text: formatCheckupWakeText(snapshot),
      kind: "checkup",
      // X1A-103: msgId doubles as event_id (see publishStateChangeWake).
      event_id: msgId,
      snapshot: snapshot.map((s) => ({
        session_id: s.sessionId,
        agent_slug: s.agentSlug,
        status: s.status,
        seconds_since_last_event: s.secondsSinceLastEvent,
        last_status: s.lastStatus,
      })),
      driverless: true,
      source: "platform",
    },
  };
  await publishInputEnvelope(nc, parentSessionId, envelope, msgId);
}

export function formatCheckupWakeText(
  snapshot: readonly ChildSnapshot[],
): string {
  if (snapshot.length === 0) {
    return [
      "[driverless wake: platform checkup — no active children]",
      "",
      "No children are currently in flight.",
      "",
      "No human is watching — do not ask clarifying questions.",
    ].join("\n");
  }
  const lines = snapshot.map((c) => {
    const mins = Math.floor(c.secondsSinceLastEvent / 60);
    const statusLine = c.lastStatus ? ` — "${c.lastStatus}"` : "";
    return `  ${c.sessionId.slice(0, 8)} (${c.agentSlug}) [${c.status}] — idle ${mins}m${statusLine}`;
  });
  return [
    "[driverless wake: platform checkup]",
    "",
    `Active children (${snapshot.length}):`,
    ...lines,
    "",
    "No human is watching — do not ask clarifying questions.",
  ].join("\n");
}

export function formatWatchdogWakeText(opts: {
  childSessionId: string;
  childSlug: string;
  silenceSeconds: number;
  attempt: number;
}): string {
  const shortId = opts.childSessionId.slice(0, 8);
  const mins = Math.floor(opts.silenceSeconds / 60);
  const attemptNote =
    opts.attempt === 1
      ? "First watchdog tick on this child."
      : `Watchdog attempt ${opts.attempt} — backoff still growing.`;
  return [
    `[driverless wake: watchdog — child silent]`,
    "",
    `Child session ${shortId} (${opts.childSlug}) has emitted no events for ${mins} minutes.`,
    attemptNote,
    "",
    "No human is watching — do not ask clarifying questions.",
  ].join("\n");
}

/**
 * Scheduler → orchestrator heartbeat wake. The scheduler calls this
 * when it ticks for an orchestrator whose live session already
 * exists; it injects the agent's `heartbeat_md` into the session
 * with `driverless: true` and `kind: "heartbeat"`, wrapped so the
 * agent knows the wake is automated.
 *
 * Unlike publishStateChangeWake, this path doesn't look anything up
 * — the scheduler already knows the session id and the heartbeat
 * text. We just publish.
 */
export async function publishHeartbeatWake(
  nc: import("nats").NatsConnection,
  sessionId: string,
  heartbeatText: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  // Scheduler tick dedup: same wall-clock = same heartbeat publish.
  const msgId = `wake.heartbeat.${sessionId}.${timestamp}`;
  const envelope = {
    session_id: sessionId,
    timestamp,
    type: "user.message",
    payload: {
      text: wrapHeartbeatText(heartbeatText),
      kind: "heartbeat",
      // X1A-103: msgId doubles as event_id (see publishStateChangeWake).
      event_id: msgId,
      driverless: true,
      source: "platform",
    },
  };
  await publishInputEnvelope(nc, sessionId, envelope, msgId);
}

/**
 * Comment → producing-session wake (X1A-55). Fires when a comment lands
 * on a share whose producing session is still alive. The producing
 * session is the one the share was originally created in — that
 * session's agent is the one we wake. v1 routing per the X1A-55
 * ticket; multi-session fan-out + per-agent `@mention` routing are
 * future extensions.
 *
 * Anti-loop is enforced one layer up (in the subscriber) by skipping
 * the publish entirely when author_session_id === producing_session_id
 * — we don't want an agent to wake itself on its own reply.
 *
 * The wake text inlines the structured `share_comment` /
 * `share_comment_resolve` MCP-tool instructions so an agent without
 * a system-prompt addendum still knows how to react.
 */
export interface CommentAddedWakeOpts {
  shareId: string;
  threadId: string;
  commentId: string;
  authorDisplay: string;
  scope: "passage" | "share";
  anchorQuote: string | null;
  body: string;
}

export async function publishCommentAddedWake(
  nc: import("nats").NatsConnection,
  producingSessionId: string,
  opts: CommentAddedWakeOpts,
): Promise<void> {
  const envelope = {
    session_id: producingSessionId,
    timestamp: new Date().toISOString(),
    type: "user.message",
    payload: {
      text: formatCommentAddedWakeText(opts),
      kind: "comment_added",
      // X1A-103: comment_id IS the event_id for share-comment wakes.
      // Locked source→event_id mapping per the X1A-103 spec.
      event_id: opts.commentId,
      share_id: opts.shareId,
      thread_id: opts.threadId,
      comment_id: opts.commentId,
      author_display: opts.authorDisplay,
      scope: opts.scope,
      anchor_quote: opts.anchorQuote,
      body: opts.body,
      source: "platform",
    },
  };
  // Each comment has a unique comment_id; using it as the dedup key
  // collapses any subscriber-side retries to a single wake.
  const msgId = `wake.comment_added.${opts.commentId}`;
  await publishInputEnvelope(nc, producingSessionId, envelope, msgId);
}

export interface CommentResolvedWakeOpts {
  shareId: string;
  threadId: string;
  resolverDisplay: string;
  resolved: boolean;
  /**
   * Server-stamped transition timestamp (ISO 8601). Discriminates the
   * msgId so a resolve → unresolve → re-resolve sequence on the same
   * thread doesn't collapse to a single message inside JetStream's
   * dedup window. Optional only for backwards-compat with older
   * payloads on the wire — when absent we fall back to publish-time
   * wall-clock, which is acceptable because the dedup window is
   * short relative to user-driven toggle cadence.
   */
  transitionedAt?: string;
}

export async function publishCommentResolvedWake(
  nc: import("nats").NatsConnection,
  producingSessionId: string,
  opts: CommentResolvedWakeOpts,
): Promise<void> {
  // Each transition has a distinct server-stamped time; (thread_id,
  // resolved-flag, transitioned_at) makes re-resolve/unresolve cycles
  // dedup correctly without collapsing legitimate toggles.
  const discriminator =
    opts.transitionedAt ?? new Date().toISOString();
  const msgId = `wake.comment_resolved.${opts.threadId}.${opts.resolved ? "1" : "0"}.${discriminator}`;
  const envelope = {
    session_id: producingSessionId,
    timestamp: new Date().toISOString(),
    type: "user.message",
    payload: {
      text: formatCommentResolvedWakeText(opts),
      kind: "comment_resolved",
      // X1A-103: msgId doubles as event_id (a resolve transition has
      // no comment_id of its own — the msgId IS the resolve event).
      event_id: msgId,
      share_id: opts.shareId,
      thread_id: opts.threadId,
      resolver_display: opts.resolverDisplay,
      resolved: opts.resolved,
      source: "platform",
    },
  };
  await publishInputEnvelope(nc, producingSessionId, envelope, msgId);
}

export function formatCommentAddedWakeText(
  opts: CommentAddedWakeOpts,
): string {
  const shortShare = opts.shareId.slice(0, 8);
  const lines = [
    `[wake: new comment on share ${shortShare}]`,
    "",
    `Author: ${opts.authorDisplay}`,
    `Thread id: ${opts.threadId}`,
    `Scope: ${opts.scope}`,
  ];
  if (opts.scope === "passage" && opts.anchorQuote) {
    lines.push(`Anchor: "${opts.anchorQuote}"`);
  } else {
    lines.push("Anchor: On this share");
  }
  lines.push("", "Body:", opts.body);
  lines.push(
    "",
    `To reply, call: share_comment(share_id="${opts.shareId}", thread_id="${opts.threadId}", text="...")`,
    `To resolve, call: share_comment_resolve(thread_id="${opts.threadId}")`,
  );
  return lines.join("\n");
}

export function formatCommentResolvedWakeText(
  opts: CommentResolvedWakeOpts,
): string {
  const shortShare = opts.shareId.slice(0, 8);
  const verb = opts.resolved ? "resolved" : "reopened";
  return [
    `[wake: comment thread ${verb} on share ${shortShare}]`,
    "",
    `Thread id: ${opts.threadId}`,
    `${opts.resolved ? "Resolved" : "Reopened"} by: ${opts.resolverDisplay}`,
    "",
    opts.resolved
      ? "Nothing required — informational. The human (or another agent) marked this thread done."
      : "Thread was previously resolved and is now reopened. The human (or another agent) may want a fresh look.",
  ].join("\n");
}

/**
 * Wrap the agent's heartbeat_md with a preamble that tells it this is
 * a scheduler-driven wake. Exported for testability. The preamble is
 * the standard driverless-mode framing described in
 * docs/architecture/orchestration.md § Driverless mode.
 */
export function wrapHeartbeatText(heartbeatMd: string): string {
  return [
    "[driverless wake: scheduler heartbeat]",
    "",
    "No human is watching — do not ask clarifying questions.",
    "",
    "---",
    "",
    heartbeatMd || "(no heartbeat_md configured for this agent)",
  ].join("\n");
}

/**
 * Extracted so it's testable without a NATS connection. The text is
 * what the agent actually reads — everything the orchestrator needs
 * to know to decide its next step has to be in this string.
 */
export function formatStateChangeWakeText(opts: {
  childSessionId: string;
  childSlug: string;
  terminalStatus: "complete" | "failed";
  completedAt: Date;
  errorMessage: string | null;
}): string {
  const shortId = opts.childSessionId.slice(0, 8);
  const when = opts.completedAt.toISOString();
  if (opts.terminalStatus === "complete") {
    return [
      "[driverless wake: child finished]",
      "",
      `Child session ${shortId} (${opts.childSlug}) transitioned to complete at ${when}.`,
      "",
      "No human is watching — do not ask clarifying questions.",
    ].join("\n");
  }
  const errLine = opts.errorMessage ? `\nError: ${opts.errorMessage}` : "";
  return [
    "[driverless wake: child failed]",
    "",
    `Child session ${shortId} (${opts.childSlug}) transitioned to failed at ${when}.${errLine}`,
    "",
    "No human is watching — do not ask clarifying questions.",
  ].join("\n");
}
