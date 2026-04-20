import type { WorkspaceId } from "@x1agent/kernel";
import {
  ResourceNotFoundError,
  SharedResourceId,
  type SharedResource,
  type SharedResourceKind,
  type SharedResourceStatus,
} from "../domain/shared-resource.js";
import type {
  CreateSharedResourceInput,
  SharedResourceRepository,
} from "../ports/shared-resource-repository.js";

export class InMemorySharedResourceRepository
  implements SharedResourceRepository
{
  private byId = new Map<SharedResourceId, SharedResource>();
  private seq = 0;

  async create(input: CreateSharedResourceInput): Promise<SharedResource> {
    const id = SharedResourceId(`res-${++this.seq}`);
    const now = new Date();
    const resource: SharedResource = {
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      version: input.version,
      provider: input.provider,
      config: input.config,
      adminSecretRef: input.adminSecretRef,
      status: "provisioning",
      statusReason: null,
      installedBy: input.installedBy,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(id, resource);
    return resource;
  }

  async findById(id: SharedResourceId): Promise<SharedResource | null> {
    return this.byId.get(id) ?? null;
  }

  async findByWorkspaceAndKind(
    workspaceId: WorkspaceId,
    kind: SharedResourceKind,
  ): Promise<SharedResource | null> {
    for (const r of this.byId.values()) {
      if (r.workspaceId === workspaceId && r.kind === kind) return r;
    }
    return null;
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly SharedResource[]> {
    return Array.from(this.byId.values()).filter(
      (r) => r.workspaceId === workspaceId,
    );
  }

  async listByStatus(
    status: SharedResourceStatus,
  ): Promise<readonly SharedResource[]> {
    return Array.from(this.byId.values()).filter((r) => r.status === status);
  }

  async updateStatus(
    id: SharedResourceId,
    status: SharedResourceStatus,
    reason: string | null,
  ): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) throw new ResourceNotFoundError(id);
    this.byId.set(id, {
      ...existing,
      status,
      statusReason: reason,
      updatedAt: new Date(),
    });
  }

  async delete(id: SharedResourceId): Promise<void> {
    this.byId.delete(id);
  }
}
