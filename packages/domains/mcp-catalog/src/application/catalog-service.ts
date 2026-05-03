import { ValidationError } from "@x1agent/kernel";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import { CatalogName } from "../domain/catalog-name.js";
import { validateManifest } from "../domain/manifest.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";

export interface CatalogSetInput {
  workspaceId: string;
  name: string;
  displayName?: string | null;
  /** OCI image ref. Provide either this or {command, args}. */
  image?: string | null;
  /** Executable to run inside the platform's mcp-runner base image. */
  command?: string | null;
  /** Argv for `command`. Defaults to []. Ignored when image is set. */
  args?: string[];
  manifest: unknown;
  description?: string;
  createdBy: string | null;
}

const COMMAND_RE = /^[A-Za-z0-9_./-]{1,64}$/;

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
    const manifest = validateManifest(input.manifest);
    const displayName =
      typeof input.displayName === "string" &&
      input.displayName.trim().length > 0
        ? input.displayName.trim()
        : null;

    const rawImage =
      typeof input.image === "string" ? input.image.trim() : "";
    const rawCommand =
      typeof input.command === "string" ? input.command.trim() : "";

    // Exactly one of (image, command) must be set. The DB CHECK
    // constraint enforces this too, but we surface a friendly error
    // instead of letting Postgres' constraint message bubble.
    if (rawImage && rawCommand) {
      throw new ValidationError(
        "image",
        "set either image OR command, not both",
      );
    }
    if (!rawImage && !rawCommand) {
      throw new ValidationError(
        "image",
        "set either image (OCI ref) or command (e.g. 'npx')",
      );
    }

    let image: string | null = null;
    let command: string | null = null;
    let args: string[] = [];

    if (rawImage) {
      if (rawImage.length > 512) {
        throw new ValidationError("image", "must be 512 chars or fewer");
      }
      image = rawImage;
    } else {
      if (!COMMAND_RE.test(rawCommand)) {
        throw new ValidationError(
          "command",
          "must be 1-64 chars, letters/digits/underscore/hyphen/dot/slash only (e.g. 'npx', 'uvx', 'node')",
        );
      }
      command = rawCommand;
      const rawArgs = input.args ?? [];
      if (!Array.isArray(rawArgs) || !rawArgs.every((a) => typeof a === "string")) {
        throw new ValidationError("args", "must be an array of strings");
      }
      if (rawArgs.length > 32) {
        throw new ValidationError("args", "must be 32 entries or fewer");
      }
      for (const a of rawArgs) {
        if (a.length > 256) {
          throw new ValidationError(
            "args",
            "each entry must be 256 chars or fewer",
          );
        }
      }
      args = rawArgs;
    }

    return this.repo.upsert({
      workspaceId: input.workspaceId,
      name,
      displayName,
      image,
      command,
      args,
      manifest,
      description: input.description ?? "",
      createdBy: input.createdBy,
    });
  }

  delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.delete(workspaceId, id);
  }
}
