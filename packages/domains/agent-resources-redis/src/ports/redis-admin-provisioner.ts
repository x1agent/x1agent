import type { SharedResource } from "@x1agent/agent-resources";

export interface InstallRedisInput {
  workspaceId: string;
  namespace: string;
  version: string;
  storageSize: string;
}

export interface InstallRedisResult {
  adminSecretRef: string;
  serviceHost: string;
  servicePort: number;
  adminUser: string;
}

/**
 * Stands up the per-workspace Redis instance. Adapters own manifest
 * generation and any initial server-config step (enabling ACLs,
 * setting a `requirepass` if the engine has not flipped to ACL-only
 * mode, etc.).
 */
export interface RedisAdminProvisioner {
  install(input: InstallRedisInput): Promise<InstallRedisResult>;
  uninstall(resource: SharedResource, namespace: string): Promise<void>;
  isReady(resource: SharedResource, namespace: string): Promise<boolean>;
}
