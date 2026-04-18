import type { Role, UserId, WorkspaceSlug } from "@x1agent/kernel";
import type { MembershipRepository } from "../ports/membership-repository.js";
import { assertRoleAtLeast, type Membership } from "../domain/membership.js";

/**
 * Application-level policy used by HTTP adapters to enforce workspace
 * access + role in one shot. Delegates to the domain's pure policy for
 * the actual rule.
 */
export async function assertRoleForSlug(
  memberships: MembershipRepository,
  userId: UserId,
  slug: WorkspaceSlug,
  min: Role,
): Promise<Membership> {
  const m = await memberships.findByUserAndSlug(userId, slug);
  return assertRoleAtLeast(m, min);
}
