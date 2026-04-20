import type { SharedResource, SharedResourceId } from "@x1agent/agent-resources";
import type { BranchCredential } from "../domain/postgres-branch.js";
import {
  PostgresBranchRowId,
  type PostgresBranch,
} from "../domain/postgres-branch.js";
import type {
  InstallPostgresInput,
  InstallPostgresResult,
  PostgresAdminProvisioner,
} from "../ports/postgres-admin-provisioner.js";
import type {
  MintBranchInput,
  PostgresBranchMinter,
} from "../ports/postgres-branch-minter.js";
import type {
  FindBranchInput,
  PostgresBranchRepository,
  UpsertBranchInput,
} from "../ports/postgres-branch-repository.js";

export class FakePostgresAdminProvisioner implements PostgresAdminProvisioner {
  installs: InstallPostgresInput[] = [];
  uninstalls: SharedResource[] = [];
  ready = true;

  async install(input: InstallPostgresInput): Promise<InstallPostgresResult> {
    this.installs.push(input);
    return {
      adminSecretRef: `pg-admin-${input.workspaceId.slice(0, 8)}`,
      serviceHost: `pg.${input.namespace}.svc.cluster.local`,
      servicePort: 5432,
      adminUser: "postgres",
      mainDatabase: "app_main",
    };
  }

  async uninstall(resource: SharedResource): Promise<void> {
    this.uninstalls.push(resource);
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }
}

export class FakePostgresBranchMinter implements PostgresBranchMinter {
  mints: MintBranchInput[] = [];
  revocations: Array<{ resource: SharedResource; branchId: string }> = [];
  nextPassword = "fake-password";

  async mint(input: MintBranchInput): Promise<BranchCredential> {
    this.mints.push(input);
    const host = (input.resource.config.serviceHost as string) ?? "pg";
    const port = (input.resource.config.servicePort as number) ?? 5432;
    return {
      dsn: `postgresql://${input.branchId}:${this.nextPassword}@${host}:${port}/${input.branchId}`,
      host,
      port,
      database: input.branchId,
      user: input.branchId,
      password: this.nextPassword,
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

export class InMemoryPostgresBranchRepository
  implements PostgresBranchRepository
{
  private rows = new Map<string, PostgresBranch>();
  private seq = 0;

  private key(
    resourceId: SharedResourceId,
    repoFullName: string,
    branchName: string,
  ): string {
    return `${resourceId}|${repoFullName}|${branchName}`;
  }

  async find(input: FindBranchInput): Promise<PostgresBranch | null> {
    const row = this.rows.get(
      this.key(input.resourceId, input.repoFullName, input.branchName),
    );
    if (!row || row.reapedAt) return null;
    return row;
  }

  async upsert(input: UpsertBranchInput): Promise<PostgresBranch> {
    const k = this.key(input.resourceId, input.repoFullName, input.branchName);
    const existing = this.rows.get(k);
    const now = new Date();
    if (existing && !existing.reapedAt) {
      const updated: PostgresBranch = { ...existing, lastUsedAt: now };
      this.rows.set(k, updated);
      return updated;
    }
    const row: PostgresBranch = {
      id: PostgresBranchRowId(`pb-${++this.seq}`),
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
  ): Promise<readonly PostgresBranch[]> {
    return Array.from(this.rows.values()).filter(
      (r) => r.resourceId === resourceId && !r.reapedAt,
    );
  }

  async markReaped(id: PostgresBranchRowId): Promise<void> {
    for (const [k, row] of this.rows.entries()) {
      if (row.id === id) {
        this.rows.set(k, { ...row, reapedAt: new Date() });
        return;
      }
    }
  }
}
