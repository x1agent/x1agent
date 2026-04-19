import { DomainError } from "@x1agent/kernel";

export class CollectionNotProvisionedError extends DomainError {
  readonly code = "collection_not_provisioned";
  constructor(public readonly handle: string) {
    super(`collection ${handle} is not provisioned on this provider`);
  }
}

export class CollectionAlreadyProvisionedError extends DomainError {
  readonly code = "collection_already_provisioned";
  constructor(public readonly handle: string) {
    super(`collection ${handle} is already provisioned`);
  }
}

export class RecordNotFoundError extends DomainError {
  readonly code = "graph_record_not_found";
  constructor(public readonly recordId: string) {
    super(`record ${recordId} not found`);
  }
}

export class InvalidGraphQueryError extends DomainError {
  readonly code = "graph_invalid_query";
  constructor(public readonly reason: string) {
    super(`query rejected: ${reason}`);
  }
}

export class GraphUnauthorizedError extends DomainError {
  readonly code = "graph_unauthorized";
  constructor(public readonly provider: string, message?: string) {
    super(message ?? `${provider} rejected the request`);
  }
}

export class GraphProviderUnreachableError extends DomainError {
  readonly code = "graph_provider_unreachable";
  constructor(public readonly provider: string, public readonly cause: string) {
    super(`${provider} unreachable: ${cause}`);
  }
}
