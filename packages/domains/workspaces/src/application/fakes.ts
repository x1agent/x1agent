import {
  Role,
  WorkspaceId,
  WorkspaceSlug,
  type UserId,
} from "@x1agent/kernel";
import type { WorkspaceRepository } from "../ports/workspace-repository.js";
import type { MembershipRepository } from "../ports/membership-repository.js";
import type { Workspace } from "../domain/workspace.js";
import {
  WORKSPACE_SETTINGS_DEFAULTS,
  type WorkspaceSettings,
} from "../domain/workspace-settings.js";
import type { Membership } from "../domain/membership.js";

let idCounter = 1;
function nextUuid(): string {
  const n = (idCounter++).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  readonly byId = new Map<string, Workspace>();

  async findById(id: WorkspaceId) {
    return this.byId.get(id) ?? null;
  }
  async findBySlug(slug: WorkspaceSlug) {
    for (const w of this.byId.values()) if (w.slug === slug) return w;
    return null;
  }
  async create(input: { slug: WorkspaceSlug; name: string }) {
    const id = WorkspaceId(nextUuid());
    const w: Workspace = {
      id,
      slug: input.slug,
      name: input.name,
      createdAt: new Date(),
      settings: { ...WORKSPACE_SETTINGS_DEFAULTS },
    };
    this.byId.set(id, w);
    return w;
  }
  async updateSettings(id: WorkspaceId, patch: Partial<WorkspaceSettings>) {
    const w = this.byId.get(id);
    if (!w) return null;
    w.settings = { ...w.settings, ...patch };
    return w;
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  readonly rows: Membership[] = [];

  constructor(private readonly workspaces: InMemoryWorkspaceRepository) {}

  async findByUserAndWorkspace(userId: UserId, workspaceId: WorkspaceId) {
    return (
      this.rows.find(
        (m) => m.userId === userId && m.workspaceId === workspaceId,
      ) ?? null
    );
  }

  async findByUserAndSlug(userId: UserId, slug: WorkspaceSlug) {
    const w = await this.workspaces.findBySlug(slug);
    if (!w) return null;
    return this.findByUserAndWorkspace(userId, w.id);
  }

  async listByUser(userId: UserId) {
    return this.rows.filter((m) => m.userId === userId);
  }

  async grant(input: {
    workspaceId: WorkspaceId;
    userId: UserId;
    role: Role;
  }) {
    const existing = await this.findByUserAndWorkspace(
      input.userId,
      input.workspaceId,
    );
    if (existing) {
      existing.role = input.role;
      return existing;
    }
    const m: Membership = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      addedAt: new Date(),
    };
    this.rows.push(m);
    return m;
  }

  async revoke(userId: UserId, workspaceId: WorkspaceId) {
    const idx = this.rows.findIndex(
      (m) => m.userId === userId && m.workspaceId === workspaceId,
    );
    if (idx >= 0) this.rows.splice(idx, 1);
  }
}
