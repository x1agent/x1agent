import { DomainError } from "@x1agent/kernel";
import type { UserId, WorkspaceId } from "@x1agent/kernel";

declare const groupIdBrand: unique symbol;
export type GroupId = string & { readonly [groupIdBrand]: true };
export const GroupId = (raw: string): GroupId => raw as GroupId;

/**
 * Three group sources, all sharing the same row shape:
 *
 *   manual  — workspace admin maintains membership by hand. Default.
 *   scim    — mirrored from an upstream IdP via SCIM 2.0. Membership
 *             is read-only on our side; a sync job overwrites.
 *   dynamic — membership computed at access-check time from `rule`.
 *             group_members has zero rows for these.
 */
export type GroupSource = "manual" | "scim" | "dynamic";

export interface Group {
  id: GroupId;
  workspaceId: WorkspaceId;
  slug: string;
  name: string;
  /**
   * X1A-107 — human-authored description shown in the Groups settings
   * UI. Null when the group was created before migration 062 or the
   * creator didn't supply one.
   */
  description: string | null;
  source: GroupSource;
  /** SCIM-only — IdP-side group identifier. */
  externalId: string | null;
  /** Dynamic-only — JSON predicate. e.g. {kind:"domain", value:"x1agent.com"}. */
  rule: Record<string, unknown> | null;
  /**
   * X1A-107 — userId of the creator. Nullable: not back-filled for
   * rows created before migration 062, and no FK so a hard-deleted
   * user doesn't cascade-delete the group.
   */
  createdBy: UserId | null;
  /**
   * X1A-107 — soft-delete marker. Null = active. When set, the group
   * is hidden from list/detail endpoints but past share rows that
   * reference it can still resolve the historical name + members for
   * tooltip display.
   */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupMembership {
  groupId: GroupId;
  userId: UserId;
  addedAt: Date;
  /**
   * X1A-107 — userId of the workspace member who added this user.
   * Nullable: not back-filled for rows created before migration 062,
   * SCIM-synced rows never set it, no FK.
   */
  addedBy: UserId | null;
}

export class GroupNotFoundError extends DomainError {
  readonly code = "group_not_found";
  constructor(public readonly id: string) {
    super(`group ${id} not found`);
  }
}

export class GroupSlugTakenError extends DomainError {
  readonly code = "group_slug_taken";
  constructor(public readonly slug: string) {
    super(`a group with slug '${slug}' already exists in this workspace`);
  }
}

/** X1A-107 — case-insensitive name collision among active manual groups. */
export class GroupNameTakenError extends DomainError {
  readonly code = "name_taken";
  constructor(public readonly name: string) {
    super(`a group named '${name}' already exists in this workspace`);
  }
}

/** X1A-107 — operation against an archived group (idempotent reads still work). */
export class GroupArchivedError extends DomainError {
  readonly code = "group_archived";
  constructor(public readonly id: string) {
    super(`group ${id} is archived`);
  }
}

/**
 * X1A-107 — validates a user-supplied group name. Trims surrounding
 * whitespace; throws DomainError subclasses the routes layer maps to
 * 400. Pure — no I/O — so it's unit-testable.
 *
 *  - 1–80 chars after trim
 *  - must contain at least one non-whitespace character
 *  - cannot start with `@` (reserved for future @group mentions per
 *    X1A-15's out-of-scope list)
 */
export class GroupNameInvalidError extends DomainError {
  readonly code = "name_invalid";
  constructor(message: string) {
    super(message);
  }
}

export function validateGroupName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new GroupNameInvalidError("name must not be empty");
  }
  if (trimmed.length > 80) {
    throw new GroupNameInvalidError("name must be 80 characters or fewer");
  }
  if (trimmed.startsWith("@")) {
    throw new GroupNameInvalidError(
      "name must not start with '@' (reserved for future @mention)",
    );
  }
  return trimmed;
}

/** X1A-107 — description: nullable, max 500 chars after trim. */
export function validateGroupDescription(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 500) {
    throw new GroupNameInvalidError(
      "description must be 500 characters or fewer",
    );
  }
  return trimmed;
}

export class CannotEditMirroredGroupError extends DomainError {
  readonly code = "cannot_edit_mirrored_group";
  constructor(public readonly source: GroupSource) {
    super(
      `group source is '${source}'; membership is mirrored upstream and cannot be edited here`,
    );
  }
}
