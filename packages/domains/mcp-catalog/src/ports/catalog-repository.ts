import type { CatalogEntry } from "../domain/catalog-entry.js";
import type { CatalogName } from "../domain/catalog-name.js";
import type { Manifest } from "../domain/manifest.js";

export interface CatalogUpsertInput {
  workspaceId: string;
  name: CatalogName;
  displayName: string | null;
  /** Exactly one of image or command is non-null; DB enforces. */
  image: string | null;
  command: string | null;
  args: string[];
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
