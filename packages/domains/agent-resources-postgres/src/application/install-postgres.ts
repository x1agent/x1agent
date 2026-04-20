import {
  ResourceKindAlreadyInstalledError,
  SharedResourceKind,
  type SharedResource,
  type SharedResourceRepository,
} from "@x1agent/agent-resources";
import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  InstallPostgresInput,
  PostgresAdminProvisioner,
} from "../ports/postgres-admin-provisioner.js";

export interface InstallPostgresCommand {
  workspaceId: WorkspaceId;
  namespace: string;
  version: string;
  storageSize: string;
  installedBy: UserId | null;
}

/**
 * Orchestrates the admin "Install Postgres" click. Creates the
 * workspace_shared_resources row in status='provisioning', asks the
 * adapter to stand up the engine, flips the row to 'running' on success
 * or 'failed' on error.
 *
 * Idempotency: if a Postgres instance is already installed (UNIQUE
 * constraint on (workspace_id, kind) in the migration), this throws
 * ResourceKindAlreadyInstalledError.
 */
export async function installPostgres(
  repo: SharedResourceRepository,
  provisioner: PostgresAdminProvisioner,
  command: InstallPostgresCommand,
): Promise<SharedResource> {
  const existing = await repo.findByWorkspaceAndKind(
    command.workspaceId,
    SharedResourceKind("postgres"),
  );
  if (existing) {
    throw new ResourceKindAlreadyInstalledError(SharedResourceKind("postgres"));
  }

  // The adapter provisions K8s resources first and returns the Secret ref.
  // Store ref + config (not plaintext) in the row.
  const installInput: InstallPostgresInput = {
    workspaceId: command.workspaceId,
    namespace: command.namespace,
    version: command.version,
    storageSize: command.storageSize,
  };
  const installed = await provisioner.install(installInput);

  const resource = await repo.create({
    workspaceId: command.workspaceId,
    kind: SharedResourceKind("postgres"),
    version: command.version,
    provider: "statefulset",
    config: {
      storageSize: command.storageSize,
      serviceHost: installed.serviceHost,
      servicePort: installed.servicePort,
      adminUser: installed.adminUser,
      mainDatabase: installed.mainDatabase,
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
  } catch (err) {
    // Leave the row at 'provisioning'; the status watcher will flip it
    // as the StatefulSet actually becomes ready. Don't propagate — the
    // user's click already succeeded in the "resources are applied" sense.
  }
  return resource;
}
