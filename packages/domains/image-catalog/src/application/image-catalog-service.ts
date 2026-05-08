import { ValidationError } from "@x1agent/kernel";
import type { AgentImage } from "../domain/agent-image.js";
import {
  DockerfileSource,
  dockerfileHash,
} from "../domain/dockerfile-source.js";
import {
  CannotMutatePresetError,
  ImageInUseError,
  ImageNameTakenError,
  ImageNotFoundError,
} from "../domain/errors.js";
import { ImageName } from "../domain/image-name.js";
import type { AgentImageRepository } from "../ports/agent-image-repository.js";
import type { AgentImageUsageReader } from "../ports/agent-image-usage-reader.js";
import type { BuildQueue } from "../ports/build-queue.js";

export interface CreateInput {
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string | null;
  dockerfileSource: string;
}

export interface UpdateInput {
  workspaceId: string;
  id: string;
  displayName?: string;
  description?: string | null;
  dockerfileSource?: string;
}

const DISPLAY_NAME_MAX = 128;
const DESCRIPTION_MAX = 1024;

/**
 * Application service for the workspace image catalog. Wires the
 * domain validators against the repository + build queue.
 *
 * Mutation contract:
 *   * presets are read-only (CannotMutatePresetError on mutate)
 *   * uniqueness is enforced server-side (ImageNameTakenError)
 *   * Dockerfile changes auto-queue a rebuild
 *   * deletes refuse if any agent in the workspace pins the image
 */
export class ImageCatalogService {
  constructor(
    private readonly repo: AgentImageRepository,
    private readonly queue: BuildQueue,
    private readonly usage: AgentImageUsageReader,
  ) {}

  list(workspaceId: string): Promise<AgentImage[]> {
    return this.repo.list(workspaceId);
  }

  async get(workspaceId: string, id: string): Promise<AgentImage> {
    const image = await this.repo.getVisible(workspaceId, id);
    if (!image) throw new ImageNotFoundError(id);
    return image;
  }

  async create(input: CreateInput): Promise<AgentImage> {
    const name = ImageName(input.name);
    const displayName = validateDisplayName(input.displayName);
    const description = validateDescription(input.description ?? null);
    const source = DockerfileSource(input.dockerfileSource);

    const existing = await this.repo.findByName(input.workspaceId, name);
    if (existing) throw new ImageNameTakenError(input.name);

    const created = await this.repo.create({
      workspaceId: input.workspaceId,
      name,
      displayName,
      description,
      dockerfileSource: source,
      builtRef: "",
      buildStatus: "pending",
    });

    await this.queue.enqueue({
      imageId: created.id,
      workspaceId: input.workspaceId,
    });

    return created;
  }

  async update(input: UpdateInput): Promise<AgentImage> {
    const existing = await this.requireWorkspaceImage(
      input.workspaceId,
      input.id,
    );

    const patch: {
      displayName?: string;
      description?: string | null;
      dockerfileSource?: DockerfileSource;
      buildStatus?: "pending";
    } = {};

    if (input.displayName !== undefined) {
      patch.displayName = validateDisplayName(input.displayName);
    }
    if (input.description !== undefined) {
      patch.description = validateDescription(input.description);
    }

    let dockerfileChanged = false;
    if (input.dockerfileSource !== undefined) {
      const next = DockerfileSource(input.dockerfileSource);
      const prevHash =
        existing.dockerfileSource === ""
          ? ""
          : dockerfileHash(existing.dockerfileSource);
      const nextHash = dockerfileHash(next);
      if (nextHash !== prevHash) {
        patch.dockerfileSource = next;
        patch.buildStatus = "pending";
        dockerfileChanged = true;
      }
    }

    if (Object.keys(patch).length === 0) {
      // Nothing to do; return existing unchanged.
      return existing;
    }

    const updated = await this.repo.update({
      workspaceId: input.workspaceId,
      id: input.id,
      ...patch,
    });
    if (!updated) throw new ImageNotFoundError(input.id);

    if (dockerfileChanged) {
      await this.queue.enqueue({
        imageId: updated.id,
        workspaceId: input.workspaceId,
      });
    }

    return updated;
  }

  async requestRebuild(
    workspaceId: string,
    id: string,
  ): Promise<AgentImage> {
    const existing = await this.requireWorkspaceImage(workspaceId, id);
    if (existing.buildStatus === "pending" || existing.buildStatus === "building") {
      // Already in flight; no-op.
      return existing;
    }
    const updated = await this.repo.update({
      workspaceId,
      id,
      buildStatus: "pending",
      buildLog: "",
    });
    if (!updated) throw new ImageNotFoundError(id);
    await this.queue.enqueue({ imageId: id, workspaceId });
    return updated;
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspaceImage(workspaceId, id);
    const usingAgents = await this.usage.agentSlugsUsingImage(workspaceId, id);
    if (usingAgents.length > 0) {
      throw new ImageInUseError(usingAgents);
    }
    const ok = await this.repo.delete(workspaceId, id);
    if (!ok) throw new ImageNotFoundError(id);
  }

  private async requireWorkspaceImage(
    workspaceId: string,
    id: string,
  ): Promise<AgentImage> {
    const image = await this.repo.getVisible(workspaceId, id);
    if (!image) throw new ImageNotFoundError(id);
    if (image.isPreset || image.workspaceId !== workspaceId) {
      throw new CannotMutatePresetError();
    }
    return image;
  }
}

function validateDisplayName(raw: string): string {
  if (typeof raw !== "string") {
    throw new ValidationError("display_name", "must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("display_name", "must not be empty");
  }
  if (trimmed.length > DISPLAY_NAME_MAX) {
    throw new ValidationError(
      "display_name",
      `must be ${DISPLAY_NAME_MAX} chars or fewer`,
    );
  }
  return trimmed;
}

function validateDescription(raw: string | null): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new ValidationError("description", "must be a string or null");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > DESCRIPTION_MAX) {
    throw new ValidationError(
      "description",
      `must be ${DESCRIPTION_MAX} chars or fewer`,
    );
  }
  return trimmed;
}
