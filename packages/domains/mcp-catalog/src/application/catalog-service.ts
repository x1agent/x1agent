import { ValidationError } from "@x1agent/kernel";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import { CatalogName } from "../domain/catalog-name.js";
import { validateManifest } from "../domain/manifest.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";

export interface CatalogSetInput {
  workspaceId: string;
  name: string;
  displayName?: string | null;
  image: string;
  manifest: unknown;
  description?: string;
  createdBy: string | null;
}

export class CatalogService {
  constructor(private readonly repo: CatalogRepository) {}

  list(workspaceId: string): Promise<CatalogEntry[]> {
    return this.repo.list(workspaceId);
  }

  get(workspaceId: string, id: string): Promise<CatalogEntry | null> {
    return this.repo.getById(workspaceId, id);
  }

  async set(input: CatalogSetInput): Promise<CatalogEntry> {
    const name = CatalogName(input.name);
    const image = input.image.trim();
    if (image.length === 0) {
      throw new ValidationError("image", "must not be empty");
    }
    if (image.length > 512) {
      throw new ValidationError("image", "must be 512 chars or fewer");
    }
    const manifest = validateManifest(input.manifest);
    const displayName =
      typeof input.displayName === "string" && input.displayName.trim().length > 0
        ? input.displayName.trim()
        : null;
    return this.repo.upsert({
      workspaceId: input.workspaceId,
      name,
      displayName,
      image,
      manifest,
      description: input.description ?? "",
      createdBy: input.createdBy,
    });
  }

  delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.delete(workspaceId, id);
  }
}
