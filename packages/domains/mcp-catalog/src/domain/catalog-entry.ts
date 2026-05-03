import type { CatalogName } from "./catalog-name.js";
import type { Manifest } from "./manifest.js";
// Re-export type to avoid a circular import — domain shouldn't depend
// on application. We declare a structural alias here.
export interface AuthorizationServerMetadataMinimal {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  [key: string]: unknown;
}

/**
 * A registered MCP server inside a workspace's catalog. The agents in
 * the workspace can attach to this entry via agent_mcp_attachments
 * rows.
 *
 * Three shapes — encoded in `kind`:
 *
 *   kind = "stdio":
 *     image OR command+args set; runs as a sibling container in the
 *     agent's pod over a stdio Unix socket. Workspace-admin holds the
 *     env secrets via the workspace_secrets store. Compatible with
 *     all agent kinds.
 *
 *   kind = "remote_oauth":
 *     url is set; the MCP server runs server-side (Mercury, Notion,
 *     etc.). Per-user OAuth tokens authenticate the agent AS the
 *     human currently driving the session. **Compatible only with
 *     worker (interactive) agents** — not orchestrators or scheduled
 *     agents — since the agent acts on behalf of a present user.
 */
export type CatalogKind = "stdio" | "remote_oauth";

export interface CatalogEntry {
  id: string;
  workspaceId: string;
  name: CatalogName;
  displayName: string | null;
  kind: CatalogKind;
  /** OCI image ref. Set only when kind=stdio. Mutually exclusive with command. */
  image: string | null;
  /** Executable to run inside the platform's mcp-runner base image. */
  command: string | null;
  /** Argv for `command`. */
  args: string[];
  /** MCP server URL. Set only when kind=remote_oauth. */
  url: string | null;
  /** Cached RFC 8414 metadata from the discovery probe. */
  oauthAuthorizationServer: AuthorizationServerMetadataMinimal | null;
  manifest: Manifest;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}
