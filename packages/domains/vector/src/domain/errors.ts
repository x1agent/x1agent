import { DomainError } from "@x1agent/kernel";

export class VectorNamespaceNotProvisionedError extends DomainError {
  readonly code = "vector_namespace_not_provisioned";
  constructor(public readonly namespace: string) {
    super(`vector namespace ${namespace} is not provisioned`);
  }
}

export class DimensionMismatchError extends DomainError {
  readonly code = "vector_dimension_mismatch";
  constructor(
    public readonly expected: number,
    public readonly got: number,
  ) {
    super(`vector length ${got} does not match namespace dimension ${expected}`);
  }
}

export class VectorUnauthorizedError extends DomainError {
  readonly code = "vector_unauthorized";
  constructor(public readonly provider: string, message?: string) {
    super(message ?? `${provider} rejected the request`);
  }
}

export class VectorProviderUnreachableError extends DomainError {
  readonly code = "vector_provider_unreachable";
  constructor(public readonly provider: string, public readonly cause: string) {
    super(`${provider} unreachable: ${cause}`);
  }
}
