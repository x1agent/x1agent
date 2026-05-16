import { describe, expect, it } from "bun:test";
import { WorkspaceId } from "@x1agent/kernel";
import {
  upsertPreviewEnvironment,
} from "./upsert-preview-environment.js";
import {
  InvalidPreviewSlugError,
  PreviewEnvironmentId,
  PreviewSlug,
  type PreviewEnvironment,
} from "../domain/preview-environment.js";
import { PreviewSlugTakenError } from "../domain/errors.js";
import type {
  PreviewEnvironmentRepository,
  UpsertPreviewEnvironmentInput,
} from "../ports/preview-environment-repository.js";

const WORKSPACE_A = WorkspaceId("00000000-0000-7000-8000-00000000000a");
const WORKSPACE_B = WorkspaceId("00000000-0000-7000-8000-00000000000b");

class FakeRepo implements PreviewEnvironmentRepository {
  public rows = new Map<string, PreviewEnvironment>();
  public upsertCalls: UpsertPreviewEnvironmentInput[] = [];

  async upsert(input: UpsertPreviewEnvironmentInput): Promise<PreviewEnvironment> {
    this.upsertCalls.push(input);
    const key = `${input.workspaceId}:${input.slug}`;
    const existing = this.rows.get(key);
    if (existing && existing.repoFullName !== input.repoFullName) {
      throw new PreviewSlugTakenError(
        input.workspaceId,
        input.slug,
        existing.repoFullName,
      );
    }
    const row: PreviewEnvironment = {
      id: existing?.id ?? PreviewEnvironmentId(
        "00000000-0000-7000-8000-0000000000ff",
      ),
      workspaceId: input.workspaceId,
      slug: input.slug,
      title: existing?.title ?? input.initialTitle,
      repoFullName: input.repoFullName,
      branch: input.branch,
      lastDeploySha: input.deploy.sha,
      lastDeployUrl: input.deploy.url,
      lastDeployImageRef: input.deploy.imageRef,
      lastDeployStatus: input.deploy.status,
      lastDeployStatusReason: input.deploy.statusReason,
      lastDeployAt: input.deploy.at,
      envVarNames: existing?.envVarNames ?? [],
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(key, row);
    return row;
  }
  async findById() { return null; }
  async findBySlug() { return null; }
  async listForWorkspace() { return []; }
  async rename(): Promise<PreviewEnvironment> {
    throw new Error("not used");
  }
  async delete() { /* not used */ }
  async setEnvVarNames(): Promise<PreviewEnvironment> {
    throw new Error("not used");
  }
}

describe("upsertPreviewEnvironment", () => {
  it("inserts a new row on first call with status=provisioning + no at-timestamp", async () => {
    const repo = new FakeRepo();
    const env = await upsertPreviewEnvironment(
      { repository: repo },
      {
        workspaceId: WORKSPACE_A,
        slug: "web-app",
        repoFullName: "acme/web-app",
        branch: "main",
        deploy: { status: "provisioning" },
      },
    );
    expect(env.slug).toBe(PreviewSlug("web-app"));
    expect(env.title).toBe("web-app");
    expect(env.lastDeployStatus).toBe("provisioning");
    expect(env.lastDeployAt).toBeNull();
  });

  it("stamps lastDeployAt when status moves to ready", async () => {
    const repo = new FakeRepo();
    const env = await upsertPreviewEnvironment(
      { repository: repo },
      {
        workspaceId: WORKSPACE_A,
        slug: "web-app",
        repoFullName: "acme/web-app",
        branch: "main",
        deploy: {
          status: "ready",
          sha: "abc123",
          url: "https://web-app.preview.example.test",
          imageRef: "registry/preview-images/web-app:abc123",
        },
      },
    );
    expect(env.lastDeployStatus).toBe("ready");
    expect(env.lastDeployAt).not.toBeNull();
    expect(env.lastDeploySha).toBe("abc123");
  });

  it("rejects an invalid slug at the domain boundary", async () => {
    const repo = new FakeRepo();
    await expect(
      upsertPreviewEnvironment(
        { repository: repo },
        {
          workspaceId: WORKSPACE_A,
          slug: "Web App!", // spaces + caps + bang — none allowed
          repoFullName: "acme/web-app",
          branch: "main",
          deploy: { status: "provisioning" },
        },
      ),
    ).rejects.toBeInstanceOf(InvalidPreviewSlugError);
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it("refuses to clobber an existing slug owned by a different repo (workspace tenancy via slug uniqueness)", async () => {
    const repo = new FakeRepo();
    await upsertPreviewEnvironment(
      { repository: repo },
      {
        workspaceId: WORKSPACE_A,
        slug: "web-app",
        repoFullName: "acme/web-app",
        branch: "main",
        deploy: { status: "provisioning" },
      },
    );
    await expect(
      upsertPreviewEnvironment(
        { repository: repo },
        {
          workspaceId: WORKSPACE_A,
          slug: "web-app",
          repoFullName: "acme/different-repo",
          branch: "main",
          deploy: { status: "provisioning" },
        },
      ),
    ).rejects.toBeInstanceOf(PreviewSlugTakenError);
  });

  it("allows the same slug in two different workspaces (tenant isolation)", async () => {
    const repo = new FakeRepo();
    const a = await upsertPreviewEnvironment(
      { repository: repo },
      {
        workspaceId: WORKSPACE_A,
        slug: "web-app",
        repoFullName: "acme/web-app",
        branch: "main",
        deploy: { status: "provisioning" },
      },
    );
    const b = await upsertPreviewEnvironment(
      { repository: repo },
      {
        workspaceId: WORKSPACE_B,
        slug: "web-app",
        repoFullName: "other-org/web-app",
        branch: "main",
        deploy: { status: "provisioning" },
      },
    );
    expect(a.workspaceId).toBe(WORKSPACE_A);
    expect(b.workspaceId).toBe(WORKSPACE_B);
  });

  it("preserves the existing title on a subsequent deploy (operator's UI rename is not clobbered)", async () => {
    const repo = new FakeRepo();
    await upsertPreviewEnvironment(
      { repository: repo },
      {
        workspaceId: WORKSPACE_A,
        slug: "web-app",
        repoFullName: "acme/web-app",
        branch: "main",
        deploy: { status: "provisioning" },
      },
    );
    // Simulate an admin renaming in the UI (the fake doesn't expose
    // rename() directly; reach in for the test).
    const key = `${WORKSPACE_A}:web-app`;
    repo.rows.get(key)!.title = "Web App — staging";

    const second = await upsertPreviewEnvironment(
      { repository: repo },
      {
        workspaceId: WORKSPACE_A,
        slug: "web-app",
        repoFullName: "acme/web-app",
        branch: "main",
        deploy: { status: "ready", sha: "def456" },
      },
    );
    expect(second.title).toBe("Web App — staging");
  });
});
