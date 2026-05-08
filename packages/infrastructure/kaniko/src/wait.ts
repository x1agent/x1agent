import type { BatchV1Api, CoreV1Api } from "@kubernetes/client-node";

export interface WaitOptions {
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Poll a Job until it Completes or Fails. Returns 'complete' | 'failed'
 * or throws if the timeout elapses without a terminal status.
 */
export async function waitForJob(
  batch: BatchV1Api,
  name: string,
  namespace: string,
  opts: WaitOptions = {},
): Promise<"complete" | "failed"> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await batch.readNamespacedJobStatus({ name, namespace });
    const status = res.status;
    if (status?.succeeded && status.succeeded > 0) return "complete";
    if (status?.failed && status.failed > 0) return "failed";
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Job ${namespace}/${name} did not reach a terminal status within ${timeoutMs / 1000}s`,
  );
}

/**
 * Read the terminationMessage from a Job's most recent pod. Used to
 * recover the Kaniko-emitted image digest after a successful build.
 * Returns null when no pod, no terminated state, or no message.
 */
export async function readJobTerminationMessage(
  core: CoreV1Api,
  jobName: string,
  namespace: string,
): Promise<string | null> {
  const podList = await core.listNamespacedPod({
    namespace,
    labelSelector: `batch.kubernetes.io/job-name=${jobName}`,
  });
  const pod = podList.items[0];
  if (!pod) return null;
  const containerStatus = pod.status?.containerStatuses?.[0];
  return containerStatus?.state?.terminated?.message ?? null;
}

/**
 * Read the tail of a Job pod's logs. Used to surface failure context
 * to admins in the UI's build log panel.
 */
export async function readJobLogTail(
  core: CoreV1Api,
  jobName: string,
  namespace: string,
  tailLines = 200,
): Promise<string> {
  const podList = await core.listNamespacedPod({
    namespace,
    labelSelector: `batch.kubernetes.io/job-name=${jobName}`,
  });
  const pod = podList.items[0];
  if (!pod || !pod.metadata?.name) return "";
  try {
    const logs = await core.readNamespacedPodLog({
      name: pod.metadata.name,
      namespace,
      tailLines,
    });
    return typeof logs === "string" ? logs : "";
  } catch {
    return "";
  }
}
