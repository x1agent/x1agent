import {
  WorkspaceId,
  type UserId,
  type WorkspaceSlug,
  DomainError,
} from "@x1agent/kernel";
import type {
  AgentRepository,
  CreateAgentInput,
  UpdateAgentInput,
} from "../ports/agent-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import {
  AgentId,
  AgentSlugTakenError,
  type Agent,
} from "../domain/agent.js";

let counter = 0x20;
function nextId(): string {
  const n = (++counter).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export class InMemoryAgentRepository implements AgentRepository {
  readonly rows = new Map<string, Agent>();

  async create(input: CreateAgentInput): Promise<Agent> {
    for (const a of this.rows.values()) {
      if (a.workspaceId === input.workspaceId && a.slug === input.slug)
        throw new AgentSlugTakenError(input.slug);
    }
    const id = AgentId(nextId());
    const now = new Date();
    const a: Agent = {
      id,
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.name,
      runtimeType: input.runtimeType,
      kind: input.kind ?? "worker",
      systemPrompt: input.systemPrompt,
      heartbeatMd: input.heartbeatMd,
      schedule: input.schedule,
      isActive: true,
      imageId: input.imageId ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      lastSchedulerTickAt: null,
    };
    this.rows.set(id, a);
    return a;
  }

  async findById(id: AgentId) {
    return this.rows.get(id) ?? null;
  }
  async findBySlug(workspaceId: WorkspaceId, slug: WorkspaceSlug) {
    for (const a of this.rows.values()) {
      if (a.workspaceId === workspaceId && a.slug === slug) return a;
    }
    return null;
  }
  async listByWorkspace(workspaceId: WorkspaceId) {
    return [...this.rows.values()].filter(
      (a) => a.workspaceId === workspaceId,
    );
  }
  async update(id: AgentId, patch: UpdateAgentInput) {
    const a = this.rows.get(id);
    if (!a) throw new Error("not found");
    const updated: Agent = {
      ...a,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.runtimeType !== undefined && { runtimeType: patch.runtimeType }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(patch.systemPrompt !== undefined && { systemPrompt: patch.systemPrompt }),
      ...(patch.heartbeatMd !== undefined && { heartbeatMd: patch.heartbeatMd }),
      ...(patch.schedule !== undefined && { schedule: patch.schedule }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      ...(patch.imageId !== undefined && { imageId: patch.imageId }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }
  async delete(id: AgentId) {
    this.rows.delete(id);
  }
  async listScheduled() {
    return [...this.rows.values()].filter(
      (a) => a.schedule !== null && a.isActive,
    );
  }
  async recordSchedulerTick(id: AgentId, at: Date) {
    const a = this.rows.get(id);
    if (!a) return;
    this.rows.set(id, { ...a, lastSchedulerTickAt: at });
  }
}

export class AllowAllAdmin implements AdminGuard {
  async assertAdmin() {
    return;
  }
}

class FakeAdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("admin denied (fake)");
  }
}

export class DenyAdmin implements AdminGuard {
  async assertAdmin(): Promise<never> {
    throw new FakeAdminDeniedError();
  }
}
