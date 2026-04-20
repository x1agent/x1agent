import { randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { SharedResource } from "@x1agent/agent-resources";
import type {
  InstallRedisInput,
  InstallRedisResult,
  RedisAdminProvisioner,
} from "../../ports/redis-admin-provisioner.js";

/**
 * Single-replica Redis 7+ StatefulSet. ACL enabled via a mounted
 * users.acl file that defines the `default` user with the admin
 * password. Per-branch ACL users are created at runtime by the
 * StatefulSetRedisBranchMinter via ACL SETUSER.
 */
export class StatefulSetRedisAdminProvisioner
  implements RedisAdminProvisioner
{
  constructor(private readonly kc: k8s.KubeConfig) {}

  async install(input: InstallRedisInput): Promise<InstallRedisResult> {
    const names = this.names(input.workspaceId);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    const adminUser = "default";
    const adminPassword = randomBytes(24).toString("base64url");

    // 1. Secret with admin password + users.acl content.
    const usersAcl = [
      // The `default` user gets every capability for admin ops.
      `user ${adminUser} on >${adminPassword} ~* &* +@all`,
    ].join("\n");

    const secretBody: k8s.V1Secret = {
      metadata: {
        name: names.adminSecret,
        namespace: input.namespace,
        labels: this.labels(input.workspaceId),
      },
      type: "Opaque",
      stringData: {
        REDIS_PASSWORD: adminPassword,
        "users.acl": usersAcl,
      },
    };
    await upsertSecret(coreApi, input.namespace, secretBody);

    // 2. Headless Service.
    const serviceBody: k8s.V1Service = {
      metadata: {
        name: names.service,
        namespace: input.namespace,
        labels: this.labels(input.workspaceId),
      },
      spec: {
        clusterIP: "None",
        selector: {
          app: "x1-redis",
          "workspace-short-id": names.short,
        },
        ports: [{ port: 6379, targetPort: 6379, protocol: "TCP" }],
      },
    };
    await upsertService(coreApi, input.namespace, serviceBody);

    // 3. StatefulSet.
    const image = `redis:${input.version}`;
    const stsBody: k8s.V1StatefulSet = {
      metadata: {
        name: names.statefulSet,
        namespace: input.namespace,
        labels: this.labels(input.workspaceId),
      },
      spec: {
        serviceName: names.service,
        replicas: 1,
        selector: {
          matchLabels: {
            app: "x1-redis",
            "workspace-short-id": names.short,
          },
        },
        template: {
          metadata: {
            labels: {
              app: "x1-redis",
              "workspace-short-id": names.short,
              "x1-component": "shared-agent-resource",
            },
          },
          spec: {
            containers: [
              {
                name: "redis",
                image,
                command: [
                  "redis-server",
                  "--aclfile",
                  "/etc/redis/users.acl",
                  "--appendonly",
                  "yes",
                  "--dir",
                  "/data",
                ],
                ports: [{ containerPort: 6379, name: "redis" }],
                volumeMounts: [
                  { name: "data", mountPath: "/data" },
                  { name: "acl", mountPath: "/etc/redis" },
                ],
                readinessProbe: {
                  exec: {
                    command: [
                      "sh",
                      "-c",
                      `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning PING | grep -q PONG`,
                    ],
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
                livenessProbe: {
                  exec: {
                    command: [
                      "sh",
                      "-c",
                      `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning PING | grep -q PONG`,
                    ],
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                },
                env: [
                  {
                    name: "REDIS_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: names.adminSecret,
                        key: "REDIS_PASSWORD",
                      },
                    },
                  },
                ],
                resources: {
                  requests: { memory: "64Mi", cpu: "50m" },
                  limits: { memory: "512Mi", cpu: "500m" },
                },
              },
            ],
            volumes: [
              {
                name: "acl",
                secret: {
                  secretName: names.adminSecret,
                  items: [{ key: "users.acl", path: "users.acl" }],
                },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: {
                requests: { storage: input.storageSize },
              },
            },
          },
        ],
      },
    };
    await upsertStatefulSet(appsApi, input.namespace, stsBody);

    return {
      adminSecretRef: names.adminSecret,
      serviceHost: `${names.service}.${input.namespace}.svc.cluster.local`,
      servicePort: 6379,
      adminUser,
    };
  }

  async uninstall(
    resource: SharedResource,
    namespace: string,
  ): Promise<void> {
    const names = this.names(resource.workspaceId);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    await safeDelete(() =>
      appsApi.deleteNamespacedStatefulSet({
        name: names.statefulSet,
        namespace,
      }),
    );
    await safeDelete(() =>
      coreApi.deleteNamespacedService({ name: names.service, namespace }),
    );
    await safeDelete(() =>
      coreApi.deleteNamespacedSecret({ name: names.adminSecret, namespace }),
    );
    const pvcs = await coreApi.listNamespacedPersistentVolumeClaim({
      namespace,
      labelSelector: `workspace-short-id=${names.short},app=x1-redis`,
    });
    for (const pvc of pvcs.items ?? []) {
      if (pvc.metadata?.name) {
        await safeDelete(() =>
          coreApi.deleteNamespacedPersistentVolumeClaim({
            name: pvc.metadata!.name!,
            namespace,
          }),
        );
      }
    }
  }

  async isReady(
    resource: SharedResource,
    namespace: string,
  ): Promise<boolean> {
    const names = this.names(resource.workspaceId);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    try {
      const sts = await appsApi.readNamespacedStatefulSet({
        name: names.statefulSet,
        namespace,
      });
      return (sts.status?.readyReplicas ?? 0) >= 1;
    } catch {
      return false;
    }
  }

  private names(workspaceId: string): {
    short: string;
    statefulSet: string;
    service: string;
    adminSecret: string;
  } {
    const short = workspaceId.replace(/-/g, "").slice(0, 8);
    return {
      short,
      statefulSet: `x1-redis-${short}`,
      service: `x1-redis-${short}`,
      adminSecret: `x1-redis-${short}-admin`,
    };
  }

  private labels(workspaceId: string): Record<string, string> {
    return {
      app: "x1-redis",
      "workspace-short-id": workspaceId.replace(/-/g, "").slice(0, 8),
      "x1-component": "shared-agent-resource",
    };
  }
}

async function upsertSecret(
  api: k8s.CoreV1Api,
  namespace: string,
  body: k8s.V1Secret,
): Promise<void> {
  try {
    await api.createNamespacedSecret({ namespace, body });
  } catch (err) {
    if (isConflict(err)) {
      await api.replaceNamespacedSecret({
        name: body.metadata!.name!,
        namespace,
        body,
      });
    } else {
      throw err;
    }
  }
}

async function upsertService(
  api: k8s.CoreV1Api,
  namespace: string,
  body: k8s.V1Service,
): Promise<void> {
  try {
    await api.createNamespacedService({ namespace, body });
  } catch (err) {
    if (isConflict(err)) {
      await api.patchNamespacedService({
        name: body.metadata!.name!,
        namespace,
        body: body as unknown as object,
      });
    } else {
      throw err;
    }
  }
}

async function upsertStatefulSet(
  api: k8s.AppsV1Api,
  namespace: string,
  body: k8s.V1StatefulSet,
): Promise<void> {
  try {
    await api.createNamespacedStatefulSet({ namespace, body });
  } catch (err) {
    if (isConflict(err)) {
      await api.replaceNamespacedStatefulSet({
        name: body.metadata!.name!,
        namespace,
        body,
      });
    } else {
      throw err;
    }
  }
}

async function safeDelete(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isConflict(err: unknown): boolean {
  return (err as { code?: number }).code === 409;
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}
