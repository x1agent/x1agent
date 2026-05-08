import { DomainError } from "@x1agent/kernel";

export class ImageNotFoundError extends DomainError {
  readonly code = "image_not_found";
  constructor(public readonly imageId: string) {
    super(`image ${imageId} not found in this workspace`);
    this.name = "ImageNotFoundError";
  }
}

export class ImageNameTakenError extends DomainError {
  readonly code = "image_name_taken";
  constructor(public readonly name: string) {
    super(`an image named '${name}' already exists in this workspace`);
    this.name = "ImageNameTakenError";
  }
}

export class CannotMutatePresetError extends DomainError {
  readonly code = "cannot_mutate_preset";
  constructor() {
    super(
      "platform presets are read-only; clone the Dockerfile into a workspace image to customize",
    );
    this.name = "CannotMutatePresetError";
  }
}

export class ImageInUseError extends DomainError {
  readonly code = "image_in_use";
  constructor(public readonly agentSlugs: string[]) {
    super(
      `image is in use by ${agentSlugs.length} agent${agentSlugs.length === 1 ? "" : "s"}: ${agentSlugs.join(", ")}`,
    );
    this.name = "ImageInUseError";
  }
}
