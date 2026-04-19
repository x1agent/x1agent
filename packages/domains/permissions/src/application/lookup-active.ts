import type { WorkspaceId } from "@x1agent/kernel";
import type {
  Grant,
  GrantSubject,
  GrantType,
} from "../domain/grant.js";
import type { PermissionGrantRepository } from "../ports/permission-grant-repository.js";

export interface LookupActiveDeps {
  grants: PermissionGrantRepository;
}

export interface LookupActiveQuery {
  workspaceId: WorkspaceId;
  subject: GrantSubject;
  grantType: GrantType;
  /**
   * Optional predicate on the `details` jsonb. Evaluated in memory
   * after the index lookup — the index narrows to subject+type, this
   * filter picks out "of those, which one matches `{child_agent_id: X}`".
   */
  matches?: (details: Record<string, unknown>) => boolean;
}

/**
 * "Does this subject hold an active grant of this type (and optionally
 * these details)?" No admin gate — this is the runtime permission
 * check called by the internal spawn endpoint and the tool-scope
 * ledger. Returns the first matching grant, or null if none.
 */
export async function findActiveGrant(
  deps: LookupActiveDeps,
  q: LookupActiveQuery,
): Promise<Grant | null> {
  const rows = await deps.grants.listActive({
    workspaceId: q.workspaceId,
    subject: q.subject,
    grantType: q.grantType,
  });
  if (!q.matches) return rows[0] ?? null;
  return rows.find((g) => q.matches!(g.details)) ?? null;
}
