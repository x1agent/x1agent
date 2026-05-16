import type {
  AccessGrantKind,
  AccessGrantRole,
  WorkspaceAccessGrant,
} from "../domain/access-grant.js";

export interface CreateAccessGrantInput {
  workspaceId: string;
  kind: AccessGrantKind;
  /** Already normalised (lowercase + valid shape). */
  value: string;
  defaultRole: AccessGrantRole | null;
  expiresAt: Date | null;
  createdBy: string | null;
}

export interface AccessGrantRepository {
  listForWorkspace(workspaceId: string): Promise<WorkspaceAccessGrant[]>;

  /**
   * INSERT … ON CONFLICT (workspace_id, kind, value) DO UPDATE so an
   * admin re-adding a grant is a no-op-equivalent refresh (updates
   * defaultRole / expiresAt / createdBy but doesn't fail).
   */
  upsert(input: CreateAccessGrantInput): Promise<WorkspaceAccessGrant>;

  delete(workspaceId: string, id: string): Promise<boolean>;

  /**
   * Used by sign-in: return every non-expired grant whose value matches
   * the given email exactly (kind='email') OR whose value matches the
   * email's domain (kind='domain'). Across all workspaces — the caller
   * materialises a membership per row.
   */
  findMatchesForEmail(email: string): Promise<WorkspaceAccessGrant[]>;
}
