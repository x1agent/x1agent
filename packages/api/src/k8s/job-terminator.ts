import * as k8s from "@kubernetes/client-node";
import type { SessionId } from "@x1agent/domain-sessions";
import { sessionJobName } from "./pod-spec.js";

/**
 * Deletes the K8s Job backing a session so cancel actually stops the
 * pod (X1A-70). Wired into `cancelSession` via composition.
 *
 * Behaviour:
 *   - foreground propagation so the pod gets cleaned up too.
 *   - 404 from the Job already-gone is treated as a no-op — the
 *     reconciler's "job disappeared" branch will pick it up if the
 *     row is somehow still flagged running.
 *   - any other K8s error is rethrown; the caller logs and swallows
 *     so a flaky K8s API doesn't break the cancel response.
 */
export class K8sJobTerminator {
  constructor(
    private readonly batchApi: k8s.BatchV1Api,
    private readonly namespace: string,
  ) {}

  async terminateForSession(sessionId: SessionId): Promise<void> {
    const name = sessionJobName(sessionId);
    try {
      await this.batchApi.deleteNamespacedJob({
        name,
        namespace: this.namespace,
        propagationPolicy: "Foreground",
      });
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      // Already gone — the reconciler handles the orphaned-row case.
      if (status === 404) return;
      throw err;
    }
  }
}
