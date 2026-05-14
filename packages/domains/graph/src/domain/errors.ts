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

/**
 * Raised when an agent-controlled SurrealQL body contains more than one
 * statement. Provision / deprovision call-paths legitimately send
 * multi-statement DDL bundles and bypass this check via the
 * `allowMultiStatement` option on `SurrealClient.sql`; every other
 * caller (agent query/write/relate/resolve, vector upsert/search/delete)
 * is single-statement by construction. See Layer 3 of t03 P0 #2.
 */
export class MultiStatementNotAllowedError extends DomainError {
  readonly code = "graph_multi_statement_not_allowed";
  constructor() {
    super(
      "multi-statement SurrealQL bodies are not allowed on this path; submit one statement per call",
    );
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
