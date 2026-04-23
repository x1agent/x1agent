import { StringCodec, type NatsConnection } from "nats";
import {
  type Session,
  type SessionRepository,
} from "@x1agent/domain-sessions";
import type { AgentRepository, AgentId } from "@x1agent/domain-agents";
import { isOrchestratorKind } from "@x1agent/domain-agents";

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
      from_session_id: childSession.id,
      from_agent_slug: String(childSlug),
      new_status: terminalStatus,
      completed_at: completedAt.toISOString(),
      error_message: errorMessage,
      driverless: true,
      source: "platform",
    },
  };

  const sc = StringCodec();
  deps.nc.publish(
    `x1.session.${parent.id}.input`,
    sc.encode(JSON.stringify(envelope)),
  );
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
  const envelope = {
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    type: "user.message",
    payload: {
      text: wrapHeartbeatText(heartbeatText),
      kind: "heartbeat",
      driverless: true,
      source: "platform",
    },
  };
  const sc = StringCodec();
  nc.publish(
    `x1.session.${sessionId}.input`,
    sc.encode(JSON.stringify(envelope)),
  );
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
    "You are being woken by the scheduler, not by a user. No human is",
    "watching this turn in real time. Per your CLAUDE.md:",
    "",
    "  1. Read your current state (roadmap, last session, pending",
    "     post-mortems).",
    "  2. Is there work that can progress without human input?",
    "     - Yes: commission it via the normal loop.",
    "     - No: emit `agent.status` = \"quiescent\" and end the turn.",
    "  3. Do NOT ask clarifying questions. If something is genuinely",
    "     blocked on a human decision, post a `share` titled",
    "     \"Needs human review: <short>\" and end the turn.",
    "",
    "Preserve tokens. If nothing has changed since the last heartbeat,",
    "your turn should be short.",
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
      "Review its output via read_session and decide next steps per your CLAUDE.md. ",
      "No human is watching this turn — do not ask clarifying questions.",
    ].join("\n");
  }
  const errLine = opts.errorMessage ? `\nError: ${opts.errorMessage}` : "";
  return [
    "[driverless wake: child failed]",
    "",
    `Child session ${shortId} (${opts.childSlug}) transitioned to failed at ${when}.${errLine}`,
    "",
    "Review via read_session, write a post-mortem share (per the convention in CLAUDE.md), ",
    "and decide whether to respawn with a narrower brief or defer. ",
    "No human is watching this turn — if genuinely blocked on a human decision, emit a share titled ",
    '"Needs human review: <summary>" and end the turn.',
  ].join("\n");
}
