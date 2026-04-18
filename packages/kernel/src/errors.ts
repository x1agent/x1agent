/**
 * Base class for domain-level errors. Carries a stable machine-readable
 * `code` so API adapters can map to HTTP status codes without leaking
 * implementation details.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
}

export class ValidationError extends DomainError {
  readonly code = "validation_error";
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
  }
}
