import { randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { SharedResource } from "@x1agent/agent-resources";
import type {
  InstallPostgresInput,
  InstallPostgresResult,
  PostgresAdminProvisioner,
} from "../../ports/postgres-admin-provisioner.js";

/**
 * Adapter that stands up a per-workspace Postgres as a single-replica
 * StatefulSet. Suitable for OrbStack dev and small production clusters.
 * No HA, no backups, no replication. Multi-replica / operator-backed
 * flavors are future adapters — see the port shape in
 * docs/architecture/shared-agent-resources.md#provider-shape.
 */
export class StatefulSetPostgresAdminProvisioner
  implements PostgresAdminProvisioner
{
  constructor(private readonly kc: k8s.KubeConfig) {}

  async install(input: InstallPostgresInput): Promise<InstallPostgresResult> {
    const names = this.names(input.workspaceId);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    const adminUser = "x1admin";
    const adminPassword = randomBytes(24).toString("base64url");

    // 1. Admin Secret. Deterministic name; upsert by delete-then-create
    // when a stale Secret is present (should not happen in happy path).
    const secretBody: k8s.V1Secret = {
      metadata: {
        name: names.adminSecret,
        namespace: input.namespace,
        labels: this.labels(input.workspaceId),
      },
      type: "Opaque",
      stringData: {
        POSTGRES_USER: adminUser,
        POSTGRES_PASSWORD: adminPassword,
        POSTGRES_DB: "postgres",
      },
    };
    await upsertSecret(coreApi, input.namespace, secretBody);

    // 2. Service.
    const serviceBody: k8s.V1Service = {
      metadata: {
        name: names.service,
        namespace: input.namespace,
        labels: this.labels(input.workspaceId),
      },
      spec: {
        clusterIP: "None",
        selector: {
          app: "x1-postgres",
          "workspace-short-id": names.short,
        },
        ports: [{ port: 5432, targetPort: 5432, protocol: "TCP" }],
      },
    };
    await upsertService(coreApi, input.namespace, serviceBody);

    // 3. StatefulSet.
    const image = `postgres:${input.version}`;
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
            app: "x1-postgres",
            "workspace-short-id": names.short,
          },
        },
        template: {
          metadata: {
            labels: {
              app: "x1-postgres",
              "workspace-short-id": names.short,
              "x1-component": "shared-agent-resource",
            },
          },
          spec: {
            securityContext: { fsGroup: 999 },
            containers: [
              {
                name: "postgres",
                image,
                ports: [{ containerPort: 5432, name: "pg" }],
                envFrom: [{ secretRef: { name: names.adminSecret } }],
                volumeMounts: [
                  { name: "data", mountPath: "/var/lib/postgresql/data" },
                ],
                readinessProbe: {
                  exec: { command: ["pg_isready", "-U", adminUser] },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
                livenessProbe: {
                  exec: { command: ["pg_isready", "-U", adminUser] },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                },
                resources: {
                  requests: { memory: "256Mi", cpu: "100m" },
                  limits: { memory: "1Gi", cpu: "1" },
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
      servicePort: 5432,
      adminUser,
      // The first branch DB is created with TEMPLATE ${mainDatabase}. We
      // use "postgres" as the template for v1 since no app baseline has
      // been loaded yet; switching to an explicit "app_main" DB is a
      // follow-up once agents have a way to seed it.
      mainDatabase: "postgres",
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
      appsApi.deleteNamespacedStatefulSet({ name: names.statefulSet, namespace }),
    );
    await safeDelete(() =>
      coreApi.deleteNamespacedService({ name: names.service, namespace }),
    );
    await safeDelete(() =>
      coreApi.deleteNamespacedSecret({ name: names.adminSecret, namespace }),
    );
    // PVC cleanup: StatefulSet PVCs are retained by default. Delete
    // explicitly by label selector.
    const pvcs = await coreApi.listNamespacedPersistentVolumeClaim({
      namespace,
      labelSelector: `workspace-short-id=${names.short},app=x1-postgres`,
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
      statefulSet: `x1-pg-${short}`,
      service: `x1-pg-${short}`,
      adminSecret: `x1-pg-${short}-admin`,
    };
  }

  private labels(workspaceId: string): Record<string, string> {
    return {
      app: "x1-postgres",
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
      // Services can't be replaced naively; patch spec instead.
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
    // 404 means already gone — idempotent delete.
    if (!isNotFound(err)) throw err;
  }
}

function isConflict(err: unknown): boolean {
  return (err as { code?: number }).code === 409;
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}
