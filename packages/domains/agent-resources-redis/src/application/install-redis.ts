import {
  ResourceKindAlreadyInstalledError,
  SharedResourceKind,
  type SharedResource,
  type SharedResourceRepository,
} from "@x1agent/agent-resources";
import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  InstallRedisInput,
  RedisAdminProvisioner,
} from "../ports/redis-admin-provisioner.js";

export interface InstallRedisCommand {
  workspaceId: WorkspaceId;
  namespace: string;
  version: string;
  storageSize: string;
  installedBy: UserId | null;
}

/**
 * "Install Redis" orchestration. Mirrors installPostgres: uniqueness
 * guard, adapter provisions K8s resources, metadata row written, status
 * flipped to 'running' on successful isReady check.
 */
export async function installRedis(
  repo: SharedResourceRepository,
  provisioner: RedisAdminProvisioner,
  command: InstallRedisCommand,
): Promise<SharedResource> {
  const existing = await repo.findByWorkspaceAndKind(
    command.workspaceId,
    SharedResourceKind("redis"),
  );
  if (existing) {
    throw new ResourceKindAlreadyInstalledError(SharedResourceKind("redis"));
  }

  const installInput: InstallRedisInput = {
    workspaceId: command.workspaceId,
    namespace: command.namespace,
    version: command.version,
    storageSize: command.storageSize,
  };
  const installed = await provisioner.install(installInput);

  const resource = await repo.create({
    workspaceId: command.workspaceId,
    kind: SharedResourceKind("redis"),
    version: command.version,
    provider: "statefulset",
    config: {
      storageSize: command.storageSize,
      serviceHost: installed.serviceHost,
      servicePort: installed.servicePort,
      adminUser: installed.adminUser,
    },
    adminSecretRef: installed.adminSecretRef,
    installedBy: command.installedBy,
  });

  try {
    const ready = await provisioner.isReady(resource, command.namespace);
    if (ready) {
      await repo.updateStatus(resource.id, "running", null);
      return { ...resource, status: "running", statusReason: null };
    }
  } catch {
    // Leave at provisioning; the readiness watcher flips it later.
  }
  return resource;
}
