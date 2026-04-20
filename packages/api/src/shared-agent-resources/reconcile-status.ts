import type {
  SharedResource,
  SharedResourceRepository,
} from "@x1agent/agent-resources";
import type { PostgresAdminProvisioner } from "@x1agent/agent-resources-postgres";
import type { RedisAdminProvisioner } from "@x1agent/agent-resources-redis";

export interface StatusReconcilerConfig {
  sharedResources: SharedResourceRepository;
  postgresProvisioner: PostgresAdminProvisioner | null;
  redisProvisioner: RedisAdminProvisioner | null;
  namespace: string;
}

export interface StatusReconcileResult {
  checked: number;
  flipped: number;
}

/**
 * Walks every resource in `status='provisioning'` and asks the engine's
 * provisioner whether it is ready. Flips to 'running' on the first
 * positive answer. Install is synchronous in the happy path (adapter
 * returns before the pod is scheduled) so this is the mechanism that
 * gets the UI past "provisioning" for StatefulSet-backed engines.
 *
 * Idempotent; safe to call concurrently with installs — the race is
 * "reconciler + install both flip to running simultaneously" which is
 * the same final state either way.
 */
export async function reconcileSharedResourceStatuses(
  cfg: StatusReconcilerConfig,
): Promise<StatusReconcileResult> {
  const pending = await cfg.sharedResources.listByStatus("provisioning");
  let flipped = 0;
  for (const resource of pending) {
    const provisioner =
      resource.kind === "postgres"
        ? cfg.postgresProvisioner
        : resource.kind === "redis"
          ? cfg.redisProvisioner
          : null;
    if (!provisioner) continue;
    let ready = false;
    try {
      ready = await provisioner.isReady(resource, cfg.namespace);
    } catch {
      ready = false;
    }
    if (ready) {
      await cfg.sharedResources.updateStatus(resource.id, "running", null);
      flipped++;
    }
  }
  return { checked: pending.length, flipped };
}
