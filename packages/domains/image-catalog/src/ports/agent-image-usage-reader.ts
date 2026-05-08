/**
 * Cross-domain read for "which agents use this image?" so DELETE can
 * refuse with a useful error before tripping the FK ON DELETE SET NULL.
 *
 * Implementation lives in the api composition root, not in the agents
 * domain — keeping the dependency direction one-way (image-catalog
 * depends on a port, not on the agents package). The composition root
 * wires a postgres-backed reader against the `agents` table.
 */
export interface AgentImageUsageReader {
  /** Slugs of every agent in this workspace whose image_id = imageId. */
  agentSlugsUsingImage(workspaceId: string, imageId: string): Promise<string[]>;
}
