import type { Grant, GrantId } from "../domain/grant.js";
import type { PermissionGrantRepository } from "../ports/permission-grant-repository.js";

export interface ConsumeGrantDeps {
  grants: PermissionGrantRepository;
}

/**
 * Atomic check-and-consume for `scope='once'` grants. Returns the
 * updated grant if the caller wins the race, null if it's already
 * consumed or revoked. Internal to the API — tools ask "am I allowed?"
 * through a separate lookup; consumption is the sidecar's side effect
 * after the user approves in the UI.
 */
export async function consumeGrant(
  deps: ConsumeGrantDeps,
  id: GrantId,
): Promise<Grant | null> {
  return deps.grants.consumeIfActive(id);
}
