import type { WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";

export interface Workspace {
  id: WorkspaceId;
  slug: WorkspaceSlug;
  name: string;
  createdAt: Date;
}
