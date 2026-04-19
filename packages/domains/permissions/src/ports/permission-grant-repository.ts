import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { SessionId } from "@x1agent/domain-sessions";
import type {
  Grant,
  GrantId,
  GrantScope,
  GrantSubject,
  GrantType,
} from "../domain/grant.js";

export interface CreateGrantInput {
  workspaceId: WorkspaceId;
  subject: GrantSubject;
  grantType: GrantType;
  details: Record<string, unknown>;
  scope: GrantScope;
  /** Must be non-null when scope === "session". */
  sessionId: SessionId | null;
  grantedByUserId: UserId;
  reason: string | null;
}

export interface ListActiveQuery {
  workspaceId: WorkspaceId;
  subject: GrantSubject;
  grantType: GrantType;
}

export interface ListQuery {
  workspaceId: WorkspaceId;
  subject?: GrantSubject;
  grantType?: GrantType;
  includeRevoked?: boolean;
}

export interface PermissionGrantRepository {
  create(input: CreateGrantInput): Promise<Grant>;

  findById(id: GrantId): Promise<Grant | null>;

  list(query: ListQuery): Promise<readonly Grant[]>;

  /**
   * Active grants (`consumed_at IS NULL AND revoked_at IS NULL`) for a
   * specific subject + grant_type. Hot path for runtime checks; must be
   * index-backed.
   */
  listActive(query: ListActiveQuery): Promise<readonly Grant[]>;

  /**
   * Atomically set `consumed_at = now()` iff the grant is still active.
   * Returns the updated grant, or null if another writer got there first
   * (or the grant was already revoked). Callers MUST treat null as "not
   * allowed" — never as a permission fallthrough.
   */
  consumeIfActive(id: GrantId): Promise<Grant | null>;

  /**
   * Soft delete: set `revoked_at = now()`. Idempotent — no-op on an
   * already-revoked row. Returns the updated grant, or null if the id
   * does not exist.
   */
  revoke(id: GrantId): Promise<Grant | null>;
}
