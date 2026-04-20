import type {
  SharedResource,
  SharedResourceId,
} from "@x1agent/agent-resources";
import type { RedisBranchCredential } from "../domain/redis-branch.js";
import {
  RedisBranchRowId,
  type RedisBranch,
} from "../domain/redis-branch.js";
import type {
  InstallRedisInput,
  InstallRedisResult,
  RedisAdminProvisioner,
} from "../ports/redis-admin-provisioner.js";
import type {
  MintRedisBranchInput,
  RedisBranchMinter,
} from "../ports/redis-branch-minter.js";
import type {
  FindRedisBranchInput,
  RedisBranchRepository,
  UpsertRedisBranchInput,
} from "../ports/redis-branch-repository.js";

export class FakeRedisAdminProvisioner implements RedisAdminProvisioner {
  installs: InstallRedisInput[] = [];
  uninstalls: SharedResource[] = [];
  ready = true;

  async install(input: InstallRedisInput): Promise<InstallRedisResult> {
    this.installs.push(input);
    return {
      adminSecretRef: `redis-admin-${input.workspaceId.slice(0, 8)}`,
      serviceHost: `redis.${input.namespace}.svc.cluster.local`,
      servicePort: 6379,
      adminUser: "default",
    };
  }

  async uninstall(resource: SharedResource): Promise<void> {
    this.uninstalls.push(resource);
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }
}

export class FakeRedisBranchMinter implements RedisBranchMinter {
  mints: MintRedisBranchInput[] = [];
  revocations: Array<{ resource: SharedResource; branchId: string }> = [];
  nextPassword = "fake-redis-password";

  async mint(input: MintRedisBranchInput): Promise<RedisBranchCredential> {
    this.mints.push(input);
    const host = (input.resource.config.serviceHost as string) ?? "redis";
    const port = (input.resource.config.servicePort as number) ?? 6379;
    return {
      url: `redis://${input.branchId}:${this.nextPassword}@${host}:${port}/0`,
      host,
      port,
      user: input.branchId,
      password: this.nextPassword,
      userPrefix: input.branchId,
    };
  }

  async revokeBranch(input: {
    resource: SharedResource;
    namespace: string;
    branchId: string;
  }): Promise<void> {
    this.revocations.push({
      resource: input.resource,
      branchId: input.branchId,
    });
  }
}

export class InMemoryRedisBranchRepository implements RedisBranchRepository {
  private rows = new Map<string, RedisBranch>();
  private seq = 0;

  private key(
    resourceId: SharedResourceId,
    repoFullName: string,
    branchName: string,
  ): string {
    return `${resourceId}|${repoFullName}|${branchName}`;
  }

  async find(input: FindRedisBranchInput): Promise<RedisBranch | null> {
    const row = this.rows.get(
      this.key(input.resourceId, input.repoFullName, input.branchName),
    );
    if (!row || row.reapedAt) return null;
    return row;
  }

  async upsert(input: UpsertRedisBranchInput): Promise<RedisBranch> {
    const k = this.key(input.resourceId, input.repoFullName, input.branchName);
    const existing = this.rows.get(k);
    const now = new Date();
    if (existing && !existing.reapedAt) {
      const updated: RedisBranch = { ...existing, lastUsedAt: now };
      this.rows.set(k, updated);
      return updated;
    }
    const row: RedisBranch = {
      id: RedisBranchRowId(`rb-${++this.seq}`),
      resourceId: input.resourceId,
      repoFullName: input.repoFullName,
      branchName: input.branchName,
      branchId: input.branchId,
      lastUsedAt: now,
      reapedAt: null,
      createdAt: now,
    };
    this.rows.set(k, row);
    return row;
  }

  async listActiveByResource(
    resourceId: SharedResourceId,
  ): Promise<readonly RedisBranch[]> {
    return Array.from(this.rows.values()).filter(
      (r) => r.resourceId === resourceId && !r.reapedAt,
    );
  }

  async markReaped(id: RedisBranchRowId): Promise<void> {
    for (const [k, row] of this.rows.entries()) {
      if (row.id === id) {
        this.rows.set(k, { ...row, reapedAt: new Date() });
        return;
      }
    }
  }
}
