import { describe, expect, it } from "bun:test";
import {
  InMemorySharedResourceRepository,
  ResourceKindAlreadyInstalledError,
} from "@x1agent/agent-resources";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import {
  FakePostgresAdminProvisioner,
  FakePostgresBranchMinter,
  InMemoryPostgresBranchRepository,
} from "./fakes.js";
import { installPostgres } from "./install-postgres.js";
import { mintPostgresBranchCredential } from "./mint-branch-credential.js";

const WS = WorkspaceId("11111111-1111-4111-8111-111111111111");
const BY = UserId("22222222-2222-4222-8222-222222222222");

function setup() {
  return {
    resources: new InMemorySharedResourceRepository(),
    branches: new InMemoryPostgresBranchRepository(),
    provisioner: new FakePostgresAdminProvisioner(),
    minter: new FakePostgresBranchMinter(),
  };
}

describe("installPostgres", () => {
  it("creates a resource row in running status when the provisioner is ready", async () => {
    const { resources, provisioner } = setup();
    const resource = await installPostgres(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "16",
      storageSize: "20Gi",
      installedBy: BY,
    });

    expect(resource.kind).toBe("postgres");
    expect(resource.version).toBe("16");
    expect(resource.provider).toBe("statefulset");
    expect(resource.adminSecretRef).toContain("pg-admin-");
    expect(resource.status).toBe("running");
    expect(resource.config.serviceHost).toBe("pg.ws-1.svc.cluster.local");
    expect(provisioner.installs).toHaveLength(1);
  });

  it("refuses a second install for the same workspace", async () => {
    const { resources, provisioner } = setup();
    await installPostgres(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "16",
      storageSize: "20Gi",
      installedBy: BY,
    });
    expect(
      installPostgres(resources, provisioner, {
        workspaceId: WS,
        namespace: "ws-1",
        version: "16",
        storageSize: "20Gi",
        installedBy: BY,
      }),
    ).rejects.toBeInstanceOf(ResourceKindAlreadyInstalledError);
  });

  it("leaves the resource in provisioning when readiness check fails softly", async () => {
    const { resources, provisioner } = setup();
    provisioner.ready = false;
    const resource = await installPostgres(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "16",
      storageSize: "20Gi",
      installedBy: BY,
    });
    expect(resource.status).toBe("provisioning");
  });
});

describe("mintPostgresBranchCredential", () => {
  it("creates a branch row on first mint and bumps last_used on second", async () => {
    const { resources, branches, provisioner, minter } = setup();
    const resource = await installPostgres(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "16",
      storageSize: "20Gi",
      installedBy: BY,
    });

    const c1 = await mintPostgresBranchCredential(minter, branches, {
      resource,
      namespace: "ws-1",
      repoFullName: "acme/api",
      branchName: "feat/x",
    });
    expect(c1.dsn).toMatch(/^postgresql:\/\/.+@.+:5432\/.+$/);
    expect(c1.user).toBe(c1.database);

    const active1 = await branches.listActiveByResource(resource.id);
    expect(active1).toHaveLength(1);
    const firstUsedAt = active1[0]!.lastUsedAt;

    // Wait a tick so lastUsedAt can move forward.
    await new Promise((r) => setTimeout(r, 2));

    const c2 = await mintPostgresBranchCredential(minter, branches, {
      resource,
      namespace: "ws-1",
      repoFullName: "acme/api",
      branchName: "feat/x",
    });
    expect(c2.user).toBe(c1.user); // same role across sessions

    const active2 = await branches.listActiveByResource(resource.id);
    expect(active2).toHaveLength(1);
    expect(active2[0]!.lastUsedAt.getTime()).toBeGreaterThanOrEqual(
      firstUsedAt.getTime(),
    );
    expect(minter.mints).toHaveLength(2);
  });

  it("distinguishes branches within the same repo", async () => {
    const { resources, branches, provisioner, minter } = setup();
    const resource = await installPostgres(resources, provisioner, {
      workspaceId: WS,
      namespace: "ws-1",
      version: "16",
      storageSize: "20Gi",
      installedBy: BY,
    });

    const cx = await mintPostgresBranchCredential(minter, branches, {
      resource,
      namespace: "ws-1",
      repoFullName: "acme/api",
      branchName: "feat/x",
    });
    const cy = await mintPostgresBranchCredential(minter, branches, {
      resource,
      namespace: "ws-1",
      repoFullName: "acme/api",
      branchName: "feat/y",
    });
    expect(cx.database).not.toBe(cy.database);
    const active = await branches.listActiveByResource(resource.id);
    expect(active).toHaveLength(2);
  });
});
