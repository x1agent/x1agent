import { DomainError } from "@x1agent/kernel";
import type { UserId, WorkspaceId } from "@x1agent/kernel";

declare const resourceIdBrand: unique symbol;
export type SharedResourceId = string & { readonly [resourceIdBrand]: true };
export const SharedResourceId = (raw: string): SharedResourceId =>
  raw as SharedResourceId;

export const RESOURCE_KINDS = ["postgres", "redis"] as const;
export type SharedResourceKind = (typeof RESOURCE_KINDS)[number];
export function SharedResourceKind(raw: string): SharedResourceKind {
  if (!RESOURCE_KINDS.includes(raw as SharedResourceKind)) {
    throw new InvalidKindError(raw);
  }
  return raw as SharedResourceKind;
}

export type SharedResourceStatus = "provisioning" | "running" | "failed";

/**
 * A shared agent resource: one installed engine in a workspace. v1 enforces
 * one instance per kind per workspace; `config` is adapter-specific and
 * validated at install time.
 */
export interface SharedResource {
  id: SharedResourceId;
  workspaceId: WorkspaceId;
  kind: SharedResourceKind;
  version: string;
  provider: string;
  config: Record<string, unknown>;
  adminSecretRef: string;
  status: SharedResourceStatus;
  statusReason: string | null;
  installedBy: UserId | null;
  createdAt: Date;
  updatedAt: Date;
}

export class InvalidKindError extends DomainError {
  readonly code = "invalid_resource_kind";
  constructor(public readonly kind: string) {
    super(`${kind} is not a recognized shared resource kind`);
  }
}

export class ResourceKindAlreadyInstalledError extends DomainError {
  readonly code = "resource_kind_already_installed";
  constructor(public readonly kind: SharedResourceKind) {
    super(`a ${kind} resource is already installed in this workspace`);
  }
}

export class ResourceNotFoundError extends DomainError {
  readonly code = "resource_not_found";
  constructor(public readonly id: string) {
    super(`shared resource ${id} not found`);
  }
}
