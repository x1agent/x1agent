import type { SharedResource } from "@x1agent/agent-resources";

export interface InstallPostgresInput {
  workspaceId: string;
  namespace: string;
  /** Engine version, e.g. "16" */
  version: string;
  /** Storage size request for the PVC, e.g. "20Gi" */
  storageSize: string;
}

export interface InstallPostgresResult {
  /** Name of the K8s Secret (in the workspace namespace) holding admin creds. */
  adminSecretRef: string;
  /** Fully-qualified cluster DNS, e.g. pg.ws-abc.svc.cluster.local */
  serviceHost: string;
  servicePort: number;
  adminUser: string;
  /** Name of the template database that branch DBs are CREATE DATABASE ... TEMPLATE <this> from. */
  mainDatabase: string;
}

/**
 * Installs or removes the workspace's Postgres instance. Adapters own the
 * K8s manifest generation (StatefulSet + Service + Secret + PVC for the
 * statefulset adapter; operator CRDs for future adapters) and the initial
 * template-database setup (CREATE DATABASE <repo>_main once the instance
 * is reachable).
 */
export interface PostgresAdminProvisioner {
  install(input: InstallPostgresInput): Promise<InstallPostgresResult>;

  /**
   * Tear down the instance and every piece of state it owns. Callers
   * should have already reaped workspace_postgres_branches rows.
   */
  uninstall(resource: SharedResource, namespace: string): Promise<void>;

  /**
   * Check whether the instance is ready to accept connections. Used at
   * install time to flip status from 'provisioning' to 'running'.
   */
  isReady(resource: SharedResource, namespace: string): Promise<boolean>;
}
