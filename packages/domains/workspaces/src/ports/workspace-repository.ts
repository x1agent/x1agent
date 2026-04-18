import type {
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { Workspace } from "../domain/workspace.js";

export interface WorkspaceRepository {
  findById(id: WorkspaceId): Promise<Workspace | null>;
  findBySlug(slug: WorkspaceSlug): Promise<Workspace | null>;

  create(input: {
    slug: WorkspaceSlug;
    name: string;
  }): Promise<Workspace>;
}
