/**
 * Outbound port for kicking off a Kaniko build. The application calls
 * this after a workspace row transitions to `pending` (create or
 * Dockerfile change). The adapter publishes to NATS subject
 * `x1.image.build`; the `image-builder` deployment subscribes (queue
 * group) and runs the actual build.
 *
 * Slice A wires a no-op stub. Slice B ships the NATS adapter and the
 * builder deployment. The port shape stays the same; only the adapter
 * changes.
 */
export interface BuildQueue {
  enqueue(input: { imageId: string; workspaceId: string }): Promise<void>;
}
