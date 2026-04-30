import type { SessionId } from "../domain/session.js";

/**
 * Platform → agent message injection port. Used when the platform
 * needs to wake an orchestrator's turn by dropping a structured
 * `user.message` into its session. Implementations publish on
 * `x1.session.{sessionId}.input`; the parent's sidecar picks it up
 * and forwards it to the agent's `/inject` endpoint.
 *
 * Kept as a port (not a direct NATS call) so the sessions domain
 * stays free of transport concerns and the use cases are testable
 * with in-memory fakes.
 *
 * See docs/architecture/orchestration.md § Server-driven wakes.
 */
export interface MessageInjector {
  /**
   * Wake an orchestrator with a scheduler heartbeat. The heartbeat
   * carries `driverless: true` so the agent knows no human is
   * present. The `text` argument is the agent's `heartbeat_md`
   * rendered verbatim.
   */
  injectHeartbeatWake(sessionId: SessionId, text: string): Promise<void>;
}
