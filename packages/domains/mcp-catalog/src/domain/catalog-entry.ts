import type { CatalogName } from "./catalog-name.js";
import type { Manifest } from "./manifest.js";

/**
 * A registered MCP server image inside a workspace's catalog. The
 * agents in the workspace can attach to this entry via
 * agent_mcp_attachments rows.
 */
export interface CatalogEntry {
  id: string;
  workspaceId: string;
  name: CatalogName;
  displayName: string | null;
  image: string;
  manifest: Manifest;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}
