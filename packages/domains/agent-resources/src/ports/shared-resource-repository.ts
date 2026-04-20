import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  SharedResource,
  SharedResourceId,
  SharedResourceKind,
  SharedResourceStatus,
} from "../domain/shared-resource.js";

export interface CreateSharedResourceInput {
  workspaceId: WorkspaceId;
  kind: SharedResourceKind;
  version: string;
  provider: string;
  config: Record<string, unknown>;
  adminSecretRef: string;
  installedBy: UserId | null;
}

export interface SharedResourceRepository {
  create(input: CreateSharedResourceInput): Promise<SharedResource>;

  findById(id: SharedResourceId): Promise<SharedResource | null>;

  findByWorkspaceAndKind(
    workspaceId: WorkspaceId,
    kind: SharedResourceKind,
  ): Promise<SharedResource | null>;

  listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly SharedResource[]>;

  updateStatus(
    id: SharedResourceId,
    status: SharedResourceStatus,
    reason: string | null,
  ): Promise<void>;

  delete(id: SharedResourceId): Promise<void>;
}
