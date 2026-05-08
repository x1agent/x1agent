import * as k8s from "@kubernetes/client-node";
import { connect, StringCodec, type NatsConnection } from "nats";
import type postgres from "postgres";
import {
  buildKanikoJob,
  parseDigestFromTerminationMessage,
  readJobLogTail,
  readJobTerminationMessage,
  waitForJob,
} from "@x1agent/infra-kaniko";

export interface ImageBuilderOptions {
  natsUrl: string;
  sql: postgres.Sql<Record<string, unknown>>;
  /** KubeConfig already loaded (from the in-cluster ServiceAccount).
   * The builder no-ops when this is undefined — api runs outside a
   * cluster (e.g. plain bun dev with no devspace) cannot create Jobs. */
  kubeConfig: k8s.KubeConfig;
  /** Namespace the Kaniko Jobs + ConfigMaps land in. Same as the api's
   * pod namespace so existing api RBAC covers Job + ConfigMap CRUD. */
  buildNamespace: string;
  /** Cluster-resolvable registry host:port. */
  registryAddress: string;
  /** True when the registry is HTTP (in-cluster dev). */
  registryInsecure: boolean;
  /** Subject the api's NatsBuildQueue publishes to. */
  subject?: string;
  /** Queue group — at-least-once delivery with crash recovery. */
  queueGroup?: string;
}

export interface ImageBuilderHandle {
  stop(): Promise<void>;
}

interface AgentImageRow {
  id: string;
  workspace_id: string;
  name: string;
  dockerfile_source: string;
  build_status: string;
  is_preset: boolean;
}

const DEFAULT_SUBJECT = "x1.image.build";
const DEFAULT_QUEUE = "image-builder";

/**
 * Subscribes to NATS x1.image.build and runs Kaniko builds for
 * workspace-authored agent_images rows. Lives inside the api process
 * for v1 — RBAC, k8s client, and Postgres connection are all already
 * available. Phase 3 may extract this to its own deployment if api
 * memory pressure becomes a problem.
 *
 * State machine per build:
 *   pending → building (UPDATE WHERE build_status='pending' wins-only)
 *           → succeeded + built_ref + last_built_at, OR
 *           → failed + build_log
 *
 * The pending → building transition is the at-most-once gate. NATS
 * delivers at-least-once; only the first consumer that flips the
 * row from pending wins. Duplicate deliveries observe `building`
 * and exit immediately.
 */
export async function startImageBuilder(
  opts: ImageBuilderOptions,
): Promise<ImageBuilderHandle> {
  const subject = opts.subject ?? DEFAULT_SUBJECT;
  const queue = opts.queueGroup ?? DEFAULT_QUEUE;

  const nc = await connect({
    servers: opts.natsUrl,
    name: "x1agent-image-builder",
    reconnect: true,
    maxReconnectAttempts: -1,
  });

  const batch = opts.kubeConfig.makeApiClient(k8s.BatchV1Api);
  const core = opts.kubeConfig.makeApiClient(k8s.CoreV1Api);

  const sc = StringCodec();
  const sub = nc.subscribe(subject, { queue });
  console.log(
    `[image-builder] subscribed to ${subject} (queue=${queue}) ns=${opts.buildNamespace} reg=${opts.registryAddress}`,
  );

  let running = true;
  const inflight = new Set<Promise<void>>();

  (async () => {
    for await (const m of sub) {
      if (!running) break;
      const text = sc.decode(m.data);
      let payload: { imageId?: string; workspaceId?: string };
      try {
        payload = JSON.parse(text) as never;
      } catch {
        console.warn(`[image-builder] dropping malformed message: ${text}`);
        continue;
      }
      const imageId = payload.imageId;
      const workspaceId = payload.workspaceId;
      if (!imageId || !workspaceId) {
        console.warn(`[image-builder] dropping message without imageId/workspaceId`);
        continue;
      }
      const p = handleBuild({
        sql: opts.sql,
        batch,
        core,
        nc,
        imageId,
        workspaceId,
        buildNamespace: opts.buildNamespace,
        registryAddress: opts.registryAddress,
        registryInsecure: opts.registryInsecure,
      })
        .catch((err) => {
          console.error(
            `[image-builder] unhandled error for image ${imageId}:`,
            err,
          );
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    }
  })();

  return {
    async stop() {
      running = false;
      try {
        sub.unsubscribe();
      } catch {
        // sub already torn down
      }
      // Let in-flight builds finish (best-effort within a short window).
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      try {
        await nc.drain();
      } catch {
        // drain race during shutdown — fine
      }
    },
  };
}

interface HandleBuildArgs {
  sql: postgres.Sql<Record<string, unknown>>;
  batch: k8s.BatchV1Api;
  core: k8s.CoreV1Api;
  nc: NatsConnection;
  imageId: string;
  workspaceId: string;
  buildNamespace: string;
  registryAddress: string;
  registryInsecure: boolean;
}

async function handleBuild(args: HandleBuildArgs): Promise<void> {
  const {
    sql,
    batch,
    core,
    imageId,
    workspaceId,
    buildNamespace,
    registryAddress,
    registryInsecure,
  } = args;

  // 1. Atomic claim. Only the consumer that flips pending → building
  // proceeds. Duplicate deliveries (NATS at-least-once, retries) hit a
  // 0-row update and exit.
  const claim = await sql<AgentImageRow[]>`
    UPDATE agent_images
    SET build_status = 'building',
        build_log = '',
        updated_at = now()
    WHERE id = ${imageId}
      AND workspace_id = ${workspaceId}
      AND is_preset = false
      AND build_status = 'pending'
    RETURNING id, workspace_id, name, dockerfile_source, build_status, is_preset
  `;
  const row = claim[0];
  if (!row) {
    // Another consumer already picked this up, or the row vanished, or
    // the row isn't in pending state. Either way, nothing to do.
    return;
  }
  console.log(
    `[image-builder] claimed image ${imageId} (ws=${workspaceId} name=${row.name})`,
  );

  // 2. Materialize the Dockerfile into a per-build ConfigMap.
  const jobName = makeJobName(imageId);
  const configMapName = `${jobName}-ctx`;
  const dockerfile = row.dockerfile_source;

  try {
    await core.createNamespacedConfigMap({
      namespace: buildNamespace,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: configMapName,
          namespace: buildNamespace,
          labels: {
            app: "x1agent",
            component: "image-build",
            "x1-image-id": imageId,
          },
        },
        data: { Dockerfile: dockerfile },
      },
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 409) {
      await failBuild(sql, imageId, workspaceId, `ConfigMap create failed: ${(err as Error).message}`);
      return;
    }
    // 409 — leftover from a previous attempt; replace.
    await core.replaceNamespacedConfigMap({
      name: configMapName,
      namespace: buildNamespace,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: configMapName, namespace: buildNamespace },
        data: { Dockerfile: dockerfile },
      },
    });
  }

  // 3. Build the Job spec + create.
  const destination = `${registryAddress}/ws/${workspaceId}/${row.name}:latest`;
  const jobSpec = buildKanikoJob({
    jobName,
    namespace: buildNamespace,
    destination,
    insecureRegistry: registryInsecure,
    context: { kind: "inline", configMapName },
    labels: {
      "x1-image-id": imageId,
      "x1-workspace-id": workspaceId,
    },
  });

  try {
    await batch.createNamespacedJob({ namespace: buildNamespace, body: jobSpec });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 409) {
      await cleanupConfigMap(core, buildNamespace, configMapName);
      await failBuild(sql, imageId, workspaceId, `Job create failed: ${(err as Error).message}`);
      return;
    }
    // Existing Job with the same name — let it finish.
  }

  // 4. Wait. Up to 30 min by default.
  let result: "complete" | "failed";
  try {
    result = await waitForJob(batch, jobName, buildNamespace);
  } catch (err) {
    await cleanupConfigMap(core, buildNamespace, configMapName);
    await cleanupJob(batch, buildNamespace, jobName);
    await failBuild(
      sql,
      imageId,
      workspaceId,
      `Job watch failed: ${(err as Error).message}`,
    );
    return;
  }

  if (result === "failed") {
    const log = await readJobLogTail(core, jobName, buildNamespace, 200);
    await cleanupConfigMap(core, buildNamespace, configMapName);
    // Leave the failed Job around — ttlSecondsAfterFinished cleans it
    // up after 600s. Admin can also re-run via "Rebuild" which generates
    // a new Job name.
    await failBuild(sql, imageId, workspaceId, log || "Kaniko Job failed (no logs captured)");
    return;
  }

  // 5. Success. Recover the digest from the pod's terminationMessage
  // and pin it as built_ref.
  const message = await readJobTerminationMessage(core, jobName, buildNamespace);
  const builtRef = parseDigestFromTerminationMessage(message);

  if (!builtRef) {
    await cleanupConfigMap(core, buildNamespace, configMapName);
    await failBuild(
      sql,
      imageId,
      workspaceId,
      `Build succeeded but digest could not be parsed from terminationMessage: ${message ?? "<empty>"}`,
    );
    return;
  }

  await sql`
    UPDATE agent_images
    SET build_status = 'succeeded',
        built_ref = ${builtRef},
        last_built_at = now(),
        build_log = '',
        updated_at = now()
    WHERE id = ${imageId} AND workspace_id = ${workspaceId}
  `;
  await cleanupConfigMap(core, buildNamespace, configMapName);
  console.log(
    `[image-builder] image ${imageId} succeeded → ${builtRef}`,
  );
}

async function failBuild(
  sql: postgres.Sql<Record<string, unknown>>,
  imageId: string,
  workspaceId: string,
  message: string,
): Promise<void> {
  await sql`
    UPDATE agent_images
    SET build_status = 'failed',
        build_log = ${message.slice(0, 8 * 1024)},
        updated_at = now()
    WHERE id = ${imageId} AND workspace_id = ${workspaceId}
  `;
  console.warn(
    `[image-builder] image ${imageId} failed: ${message.split("\n")[0]?.slice(0, 200) ?? ""}`,
  );
}

async function cleanupConfigMap(
  core: k8s.CoreV1Api,
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await core.deleteNamespacedConfigMap({ name, namespace });
  } catch {
    // best-effort
  }
}

async function cleanupJob(
  batch: k8s.BatchV1Api,
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await batch.deleteNamespacedJob({
      name,
      namespace,
      propagationPolicy: "Background",
    });
  } catch {
    // best-effort
  }
}

/**
 * Job name format: image-build-<short_id>-<short_ts>. DNS-1123 label,
 * deterministic enough for log lookup but unique per save so a
 * "Rebuild" doesn't collide with the previous Job's still-cleaning-up
 * resources.
 */
function makeJobName(imageId: string): string {
  const shortId = imageId.replace(/-/g, "").slice(0, 12);
  const ts = Date.now().toString(36); // ~8 chars
  return `image-build-${shortId}-${ts}`.slice(0, 63);
}
