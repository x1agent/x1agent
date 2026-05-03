import type { CatalogEntry } from "../domain/catalog-entry.js";
import type { CatalogName } from "../domain/catalog-name.js";
import type { Manifest } from "../domain/manifest.js";

export interface CatalogUpsertInput {
  workspaceId: string;
  name: CatalogName;
  displayName: string | null;
  /** "stdio" | "remote_oauth". DB CHECK enforces field combinations. */
  kind: "stdio" | "remote_oauth";
  /** stdio shape, mutually exclusive with command. */
  image: string | null;
  command: string | null;
  args: string[];
  /** remote_oauth shape. */
  url: string | null;
  oauthAuthorizationServer: unknown | null;
  manifest: Manifest;
  description: string;
  createdBy: string | null;
}

export interface CatalogRepository {
  list(workspaceId: string): Promise<CatalogEntry[]>;
  getById(workspaceId: string, id: string): Promise<CatalogEntry | null>;
  getByName(workspaceId: string, name: CatalogName): Promise<CatalogEntry | null>;
  upsert(input: CatalogUpsertInput): Promise<CatalogEntry>;
  delete(workspaceId: string, id: string): Promise<boolean>;
}
