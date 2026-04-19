import { DomainError, type UserId, type WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import type { CollectionHandle } from "@x1agent/domain-graph";
import {
  CollectionId,
  CollectionSlug,
  type AgentCollectionAttachment,
  type Collection,
  type CollectionProviderType,
} from "../domain/collection.js";
import type {
  AttachInput,
  CollectionRepository,
  CreateCollectionInput,
  UpdateCollectionInput,
} from "../ports/collection-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { ProviderGateway } from "../ports/provider-gateway.js";

let idCounter = 0x200;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-7000-8000-${idCounter.toString(16).padStart(12, "0")}`;
}

export class InMemoryCollectionRepository implements CollectionRepository {
  readonly rows: Collection[] = [];
  readonly attachments: AgentCollectionAttachment[] = [];

  async create(input: CreateCollectionInput): Promise<Collection> {
    const c: Collection = {
      id: CollectionId(nextId()),
      workspaceId: input.workspaceId,
      name: input.name,
      slug: input.slug,
      description: input.description,
      providerType: input.providerType,
      backendHandle: input.backendHandle as CollectionHandle,
      settings: { ...input.settings },
      createdBy: input.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(c);
    return c;
  }

  async findById(id: CollectionId): Promise<Collection | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async findBySlug(
    workspaceId: WorkspaceId,
    slug: CollectionSlug,
  ): Promise<Collection | null> {
    return (
      this.rows.find(
        (r) => r.workspaceId === workspaceId && r.slug === slug,
      ) ?? null
    );
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly Collection[]> {
    return this.rows
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async update(
    id: CollectionId,
    patch: UpdateCollectionInput,
  ): Promise<Collection> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i === -1) throw new Error("not found");
    const cur = this.rows[i]!;
    const next: Collection = {
      ...cur,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description,
      }),
      ...(patch.settings !== undefined && { settings: patch.settings }),
      updatedAt: new Date(),
    };
    this.rows[i] = next;
    return next;
  }

  async delete(id: CollectionId): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i !== -1) this.rows.splice(i, 1);
    // cascade
    for (let j = this.attachments.length - 1; j >= 0; j--) {
      if (this.attachments[j]!.collectionId === id)
        this.attachments.splice(j, 1);
    }
  }

  async listForAgent(
    agentId: AgentId,
  ): Promise<readonly AgentCollectionAttachment[]> {
    return this.attachments.filter((a) => a.agentId === agentId);
  }

  async listCollectionsForAgent(
    agentId: AgentId,
  ): Promise<readonly (Collection & { isDefault: boolean })[]> {
    const out: (Collection & { isDefault: boolean })[] = [];
    for (const a of this.attachments) {
      if (a.agentId !== agentId) continue;
      const c = this.rows.find((r) => r.id === a.collectionId);
      if (c) out.push({ ...c, isDefault: a.isDefault });
    }
    return out;
  }

  async attach(input: AttachInput): Promise<AgentCollectionAttachment> {
    await this.detach(input.agentId, input.collectionId);
    if (input.isDefault) {
      // Demote any existing default on this agent.
      for (let i = 0; i < this.attachments.length; i++) {
        if (this.attachments[i]!.agentId === input.agentId)
          this.attachments[i] = {
            ...this.attachments[i]!,
            isDefault: false,
          };
      }
    }
    const row: AgentCollectionAttachment = {
      agentId: input.agentId,
      collectionId: input.collectionId,
      isDefault: input.isDefault,
      attachedAt: new Date(),
    };
    this.attachments.push(row);
    return row;
  }

  async detach(
    agentId: AgentId,
    collectionId: CollectionId,
  ): Promise<void> {
    const i = this.attachments.findIndex(
      (a) => a.agentId === agentId && a.collectionId === collectionId,
    );
    if (i !== -1) this.attachments.splice(i, 1);
  }

  async syncAttachments(
    agentId: AgentId,
    _workspaceId: WorkspaceId,
    collectionIds: readonly CollectionId[],
    defaultCollectionId: CollectionId | null,
  ): Promise<void> {
    // Drop existing
    for (let i = this.attachments.length - 1; i >= 0; i--) {
      if (this.attachments[i]!.agentId === agentId)
        this.attachments.splice(i, 1);
    }
    // Insert new
    for (const cid of collectionIds) {
      this.attachments.push({
        agentId,
        collectionId: cid,
        isDefault: cid === defaultCollectionId,
        attachedAt: new Date(),
      });
    }
  }
}

class FakeAdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("admin denied (fake)");
  }
}

export class AllowAllAdmin implements AdminGuard {
  async assertAdmin(_u: UserId, _w: WorkspaceId): Promise<void> {}
}

export class DenyAdmin implements AdminGuard {
  async assertAdmin(): Promise<never> {
    throw new FakeAdminDeniedError();
  }
}

/** Records every provision/deprovision call so tests can assert the
 *  application layer invoked the provider correctly. */
export class RecordingProviderGateway implements ProviderGateway {
  readonly calls: Array<{
    kind: "provision" | "deprovision";
    providerType: CollectionProviderType;
    handle: string;
  }> = [];

  async provision(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
  ): Promise<void> {
    this.calls.push({ kind: "provision", providerType, handle });
  }
  async deprovision(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
  ): Promise<void> {
    this.calls.push({ kind: "deprovision", providerType, handle });
  }
}
