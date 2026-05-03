import type { CatalogName } from "./catalog-name.js";
import type { Manifest } from "./manifest.js";

/**
 * A registered MCP server inside a workspace's catalog. The agents in
 * the workspace can attach to this entry via agent_mcp_attachments
 * rows.
 *
 * Two shapes — exactly one of `image` or `command` is set:
 *
 *   * image:   OCI image ref. The runtime spawns this image directly
 *              as a sibling container in the agent's pod. Use when the
 *              MCP author publishes a container.
 *
 *   * command + args: executable + args. The runtime spawns the
 *              platform's generic mcp-runner image (node + python +
 *              uv preinstalled) and runs the command inside it. Use
 *              when the MCP is distributed as `npx` / `uvx` (most
 *              servers in the wild — matches Claude Desktop's
 *              claude.json shape).
 */
export interface CatalogEntry {
  id: string;
  workspaceId: string;
  name: CatalogName;
  displayName: string | null;
  /** OCI image ref. Mutually exclusive with `command`. */
  image: string | null;
  /** Executable to run inside the platform's mcp-runner base image. */
  command: string | null;
  /** Argv for `command`. Empty array is fine; ignored when image is set. */
  args: string[];
  manifest: Manifest;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}
