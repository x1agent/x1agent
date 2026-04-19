import { DomainError, ValidationError } from "@x1agent/kernel";
import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import type { SessionId } from "@x1agent/domain-sessions";

declare const grantIdBrand: unique symbol;
export type GrantId = string & { readonly [grantIdBrand]: true };
export const GrantId = (raw: string): GrantId => raw as GrantId;

/**
 * Every grant answers the same runtime question: "is this caller allowed
 * to do this thing right now?" The subject is who asked. Exactly one of
 * the two halves is populated — splitting keeps the Postgres FK enforceable
 * on either side, which a polymorphic single column couldn't.
 */
export type GrantSubject =
  | { kind: "user"; userId: UserId }
  | { kind: "agent"; agentId: AgentId };

const GRANT_SCOPES = ["once", "session", "persistent"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];
export const GrantScope = (raw: string): GrantScope => {
  if ((GRANT_SCOPES as readonly string[]).includes(raw)) return raw as GrantScope;
  throw new ValidationError(
    "scope",
    `scope must be one of ${GRANT_SCOPES.join(", ")}`,
  );
};

/**
 * `grant_type` is an open-ended text column in the database. The set of
 * types the system actually understands is declared in the type registry
 * under `domain/details/`; an insert with an unknown type is rejected
 * by the application layer.
 */
export type GrantType = string & { readonly __grantType: unique symbol };
const GRANT_TYPE_RE = /^[a-z][a-z0-9_]*$/;
export const GrantType = (raw: string): GrantType => {
  if (!GRANT_TYPE_RE.test(raw))
    throw new ValidationError(
      "grant_type",
      "grant_type must be lowercase snake_case",
    );
  return raw as GrantType;
};

export interface Grant {
  id: GrantId;
  workspaceId: WorkspaceId;
  subject: GrantSubject;
  grantType: GrantType;
  details: Record<string, unknown>;

  scope: GrantScope;
  /** Set only when scope === "session". */
  sessionId: SessionId | null;

  consumedAt: Date | null;
  revokedAt: Date | null;

  grantedByUserId: UserId;
  grantedAt: Date;
  reason: string | null;
}

export function isGrantActive(g: Grant, now: Date = new Date()): boolean {
  void now;
  return g.consumedAt === null && g.revokedAt === null;
}

export class GrantNotFoundError extends DomainError {
  readonly code = "grant_not_found";
  constructor(public readonly id: string) {
    super(`grant ${id} not found`);
  }
}

export class GrantAlreadyConsumedError extends DomainError {
  readonly code = "grant_already_consumed";
  constructor(public readonly id: string) {
    super(`grant ${id} is already consumed`);
  }
}

export class GrantAlreadyRevokedError extends DomainError {
  readonly code = "grant_already_revoked";
  constructor(public readonly id: string) {
    super(`grant ${id} is already revoked`);
  }
}

export class InvalidGrantShapeError extends DomainError {
  readonly code = "invalid_grant_shape";
  constructor(message: string) {
    super(message);
  }
}
