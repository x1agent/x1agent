import type { BuildQueue } from "../../ports/build-queue.js";

/**
 * NATS adapter for the BuildQueue port. Slice A ships a no-op stub —
 * Slice B replaces this with a real `nats.publish('x1.image.build', ...)`
 * once the image-builder deployment exists to consume the messages.
 *
 * The no-op is INTENTIONAL: rows transition to `pending` and stay there.
 * The UI surfaces "pending" with a clear "build pipeline coming" hint
 * (Slice A drawer copy). Picking the row in the agent dropdown is
 * blocked by the selectability filter (`(ready, succeeded)` only).
 */
export interface NatsClientLike {
  publish(subject: string, payload: Uint8Array): void;
}

export class NoopBuildQueue implements BuildQueue {
  enqueue(): Promise<void> {
    return Promise.resolve();
  }
}

export class NatsBuildQueue implements BuildQueue {
  constructor(
    private readonly nats: NatsClientLike,
    private readonly subject = "x1.image.build",
  ) {}

  enqueue(input: { imageId: string; workspaceId: string }): Promise<void> {
    const payload = new TextEncoder().encode(JSON.stringify(input));
    this.nats.publish(this.subject, payload);
    return Promise.resolve();
  }
}
