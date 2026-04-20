import { describe, expect, it } from "bun:test";
import {
  InMemorySharedResourceRepository,
  ResourceKindAlreadyInstalledError,
} from "@x1agent/agent-resources";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import {
  FakeRedisAdminProvisioner,
  FakeRedisBranchMinter,
  InMemoryRedisBranchRepository,
} from "./fakes.js";
import { installRedis } from "./install-redis.js";
import { mintRedisBranchCredential } from "./mint-redis-branch-credential.js";

const WS = WorkspaceId("11111111-1111-4111-8111-111111111111");
const BY = UserId("22222222-2222-4222-8222-222222222222");

function setup() {
  return {
    resources: new InMemorySharedResourceRepository(),
    branches: new InMemoryRedisBranchRepository(),
    provisioner: new FakeRedisAdminProvisioner(),
    minter: new FakeRedisBranchMinter(),
  };
}

describe("installRedis", () => {
  it("creates a resource row in running status when provisioner is ready", async () => {
    const { resources, provisioner } = setup();
    const r = await installRedis(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "7",
      storageSize: "5Gi",
      installedBy: BY,
    });
    expect(r.kind).toBe("redis");
    expect(r.version).toBe("7");
    expect(r.status).toBe("running");
    expect(r.adminSecretRef).toContain("redis-admin-");
    expect(provisioner.installs).toHaveLength(1);
  });

  it("refuses a second install for the same workspace", async () => {
    const { resources, provisioner } = setup();
    await installRedis(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "7",
      storageSize: "5Gi",
      installedBy: BY,
    });
    expect(
      installRedis(resources, provisioner, {
        workspaceId: WS,
        namespace: "ws-1",
        version: "7",
        storageSize: "5Gi",
        installedBy: BY,
      }),
    ).rejects.toBeInstanceOf(ResourceKindAlreadyInstalledError);
  });
});

describe("mintRedisBranchCredential", () => {
  it("issues a scoped credential and remembers the branch", async () => {
    const { resources, branches, provisioner, minter } = setup();
    const resource = await installRedis(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "7",
      storageSize: "5Gi",
      installedBy: BY,
    });

    const cred = await mintRedisBranchCredential(minter, branches, {
      resource,
      namespace: "ws-1",
      repoFullName: "acme/api",
      branchName: "feat/x",
    });
    expect(cred.url).toMatch(/^redis:\/\/.+@.+:6379\/0$/);
    expect(cred.userPrefix).toBe(cred.user);
    const active = await branches.listActiveByResource(resource.id);
    expect(active).toHaveLength(1);
  });

  it("distinguishes branches within the same repo", async () => {
    const { resources, branches, provisioner, minter } = setup();
    const resource = await installRedis(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "7",
      storageSize: "5Gi",
      installedBy: BY,
    });
    const cx = await mintRedisBranchCredential(minter, branches, {
      resource,
      namespace: "ws-1",
      repoFullName: "acme/api",
      branchName: "feat/x",
    });
    const cy = await mintRedisBranchCredential(minter, branches, {
      resource,
      namespace: "ws-1",
      repoFullName: "acme/api",
      branchName: "feat/y",
    });
    expect(cx.user).not.toBe(cy.user);
    expect(cx.userPrefix).not.toBe(cy.userPrefix);
  });
});
