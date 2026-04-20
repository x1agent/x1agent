import { randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import Redis from "ioredis";
import type { SharedResource } from "@x1agent/agent-resources";
import type { RedisBranchCredential } from "../../domain/redis-branch.js";
import type {
  MintRedisBranchInput,
  RedisBranchMinter,
} from "../../ports/redis-branch-minter.js";

/**
 * Uses ACL SETUSER to create or re-password a per-branch user with a
 * pattern restriction that limits the user to keys matching
 * `<branchId>:*` and pub/sub channels matching `<branchId>:*`. The
 * shared `-@dangerous` category removes FLUSHDB/FLUSHALL/SHUTDOWN/
 * DEBUG/CONFIG so a branch-scoped agent cannot nuke the instance.
 */
export class StatefulSetRedisBranchMinter implements RedisBranchMinter {
  constructor(private readonly kc: k8s.KubeConfig) {}

  async mint(input: MintRedisBranchInput): Promise<RedisBranchCredential> {
    const { host, port } = readConnParts(input.resource);
    const admin = await this.adminCreds(input.resource, input.namespace);
    const password = randomBytes(24).toString("base64url");
    const prefix = input.branchId;

    const client = new Redis({
      host,
      port,
      username: admin.user,
      password: admin.password,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    try {
      await client.connect();
      // ACL SETUSER is idempotent: re-running refreshes rules.
      await client.call(
        "ACL",
        "SETUSER",
        prefix,
        "on",
        `>${password}`,
        `~${prefix}:*`,
        `&${prefix}:*`,
        "+@all",
        "-@dangerous",
      );
    } finally {
      await client.quit().catch(() => undefined);
    }

    const userEnc = encodeURIComponent(prefix);
    const passEnc = encodeURIComponent(password);
    return {
      url: `redis://${userEnc}:${passEnc}@${host}:${port}/0`,
      host,
      port,
      user: prefix,
      password,
      userPrefix: prefix,
    };
  }

  async revokeBranch(input: {
    resource: SharedResource;
    namespace: string;
    branchId: string;
  }): Promise<void> {
    const { host, port } = readConnParts(input.resource);
    const admin = await this.adminCreds(input.resource, input.namespace);
    const client = new Redis({
      host,
      port,
      username: admin.user,
      password: admin.password,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    try {
      await client.connect();
      await client.call("ACL", "DELUSER", input.branchId).catch(() => undefined);
      // Async prefix sweep; SCAN + UNLINK keeps the call non-blocking.
      // Chunks of 1000 keys per iteration.
      let cursor = "0";
      do {
        const [next, keys] = (await client.scan(
          cursor,
          "MATCH",
          `${input.branchId}:*`,
          "COUNT",
          "1000",
        )) as [string, string[]];
        cursor = next;
        if (keys.length > 0) {
          await client.unlink(...keys).catch(() => undefined);
        }
      } while (cursor !== "0");
    } finally {
      await client.quit().catch(() => undefined);
    }
  }

  private async adminCreds(
    resource: SharedResource,
    namespace: string,
  ): Promise<{ user: string; password: string }> {
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const secret = await coreApi.readNamespacedSecret({
      name: resource.adminSecretRef,
      namespace,
    });
    const data = secret.data ?? {};
    const cfg = resource.config as Record<string, unknown>;
    return {
      user: (cfg.adminUser as string) ?? "default",
      password: decodeBase64(data.REDIS_PASSWORD),
    };
  }
}

function readConnParts(resource: SharedResource): {
  host: string;
  port: number;
} {
  const cfg = resource.config as Record<string, unknown>;
  return {
    host: (cfg.serviceHost as string) ?? "localhost",
    port: (cfg.servicePort as number) ?? 6379,
  };
}

function decodeBase64(v: string | undefined): string {
  if (!v) return "";
  return Buffer.from(v, "base64").toString("utf8");
}
