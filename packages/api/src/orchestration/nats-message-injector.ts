import type { NatsConnection } from "nats";
import type { MessageInjector } from "@x1agent/domain-sessions";
import type { SessionId } from "@x1agent/domain-sessions";
import { publishHeartbeatWake } from "./wake-publisher.js";

/**
 * NATS-backed implementation of the sessions domain's MessageInjector
 * port. Used by the scheduler when it ticks on an orchestrator that
 * already has a live session — the tick injects a heartbeat user
 * message into the running session rather than creating a duplicate.
 *
 * See docs/architecture/orchestration.md § Server-driven wakes.
 */
export class NatsMessageInjector implements MessageInjector {
  constructor(private readonly nc: NatsConnection) {}

  async injectHeartbeatWake(sessionId: SessionId, text: string): Promise<void> {
    await publishHeartbeatWake(this.nc, sessionId, text);
  }
}
