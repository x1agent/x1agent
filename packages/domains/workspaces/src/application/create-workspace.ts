import { WorkspaceSlug, type Email, type UserId } from "@x1agent/kernel";
import { DomainError } from "@x1agent/kernel";
import type { WorkspaceRepository } from "../ports/workspace-repository.js";
import type { MembershipRepository } from "../ports/membership-repository.js";
import type { Workspace } from "../domain/workspace.js";

/**
 * Platform-admin-only: create a new workspace + add the caller as
 * `owner` in a single logical operation.
 *
 * Why "platform admin only" at this layer:
 *   The first workspace on a fresh install has nobody with a workspace
 *   role to grant create-workspace permission against — so the create
 *   gate has to live one layer up at platform-admin scope. Future:
 *   workspace owners can create additional workspaces too; relax the
 *   gate via a new `WorkspacePermissions` port and remove the role
 *   check from this function.
 *
 * Errors:
 *   - NotPlatformAdminError: caller's email isn't in the install's
 *     PLATFORM_ADMIN_EMAILS list
 *   - WorkspaceSlugTakenError: another workspace already owns this slug
 *   - ValidationError (from WorkspaceSlug): slug doesn't match the
 *     URL-safe pattern
 *
 * Idempotency:
 *   NOT idempotent on slug. Two callers requesting the same slug get
 *   one success + one WorkspaceSlugTakenError. Membership grant IS
 *   idempotent (handled by the repo).
 */

export class NotPlatformAdminError extends DomainError {
  constructor(public readonly email: Email) {
    super(`${email} is not a platform admin`);
  }
}

export class WorkspaceSlugTakenError extends DomainError {
  constructor(public readonly slug: string) {
    super(`workspace slug "${slug}" is already taken`);
  }
}

export interface CreateWorkspaceInput {
  /** URL-safe slug (will be validated through WorkspaceSlug brand). */
  slug: string;
  /** Human-readable display name. */
  name: string;
  /** Caller's user id — gets added as `owner`. */
  creatorUserId: UserId;
  /** Caller's email — checked against the platform admin list. */
  creatorEmail: Email;
}

export interface CreateWorkspaceDeps {
  workspaces: WorkspaceRepository;
  memberships: MembershipRepository;
  /**
   * Lowercased emails that are platform admins on this install.
   * Sourced from PLATFORM_ADMIN_EMAILS at composition root.
   */
  platformAdmins: readonly string[];
}

export async function createWorkspace(
  deps: CreateWorkspaceDeps,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  // Gate: platform-admin only at this layer (see header).
  const callerEmail = input.creatorEmail.toLowerCase();
  if (!deps.platformAdmins.map((e) => e.toLowerCase()).includes(callerEmail)) {
    throw new NotPlatformAdminError(input.creatorEmail);
  }

  // Slug validation throws ValidationError before any DB write.
  const slug = WorkspaceSlug(input.slug);
  const trimmedName = input.name.trim();
  if (trimmedName.length === 0) {
    throw new DomainError("workspace name cannot be empty");
  }
  if (trimmedName.length > 64) {
    throw new DomainError("workspace name cannot exceed 64 chars");
  }

  // Slug uniqueness check. Race: between this check and the create
  // call, another caller could claim it — repo translates the unique
  // violation into WorkspaceSlugTakenError.
  const existing = await deps.workspaces.findBySlug(slug);
  if (existing !== null) {
    throw new WorkspaceSlugTakenError(slug);
  }

  let workspace: Workspace;
  try {
    workspace = await deps.workspaces.create({ slug, name: trimmedName });
  } catch (err) {
    // PostgresWorkspaceRepository should throw this when the unique
    // constraint trips. Fall back to generic check otherwise.
    if (
      err instanceof Error &&
      /unique|duplicate|already exists/i.test(err.message)
    ) {
      throw new WorkspaceSlugTakenError(slug);
    }
    throw err;
  }

  // Owner membership. grant() is idempotent — safe under retry.
  await deps.memberships.grant({
    workspaceId: workspace.id,
    userId: input.creatorUserId,
    role: "owner",
  });

  return workspace;
}
