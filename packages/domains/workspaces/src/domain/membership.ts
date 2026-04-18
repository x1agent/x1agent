import { satisfies, type Role, type UserId, type WorkspaceId } from "@x1agent/kernel";
import { DomainError } from "@x1agent/kernel";

export interface Membership {
  workspaceId: WorkspaceId;
  userId: UserId;
  role: Role;
  addedAt: Date;
}

export class NotAMemberError extends DomainError {
  readonly code = "not_a_member";
  constructor(
    public readonly userId: UserId,
    public readonly workspaceId: WorkspaceId,
  ) {
    super(`user ${userId} is not a member of workspace ${workspaceId}`);
  }
}

export class InsufficientRoleError extends DomainError {
  readonly code = "insufficient_role";
  constructor(
    public readonly actual: Role,
    public readonly required: Role,
  ) {
    super(`role ${actual} does not satisfy requirement ${required}`);
  }
}

/** Pure policy: returns the membership when its role meets `min`, else throws. */
export function assertRoleAtLeast(
  membership: Membership | null,
  min: Role,
): Membership {
  if (!membership) {
    throw new NotAMemberError(
      (membership as unknown as { userId: UserId })?.userId ?? ("" as UserId),
      (membership as unknown as { workspaceId: WorkspaceId })?.workspaceId ??
        ("" as WorkspaceId),
    );
  }
  if (!satisfies(membership.role, min)) {
    throw new InsufficientRoleError(membership.role, min);
  }
  return membership;
}
