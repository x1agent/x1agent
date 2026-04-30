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
  source: GroupSource;
  /** SCIM-only — IdP-side group identifier. */
  externalId: string | null;
  /** Dynamic-only — JSON predicate. e.g. {kind:"domain", value:"x1agent.com"}. */
  rule: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupMembership {
  groupId: GroupId;
  userId: UserId;
  addedAt: Date;
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

export class CannotEditMirroredGroupError extends DomainError {
  readonly code = "cannot_edit_mirrored_group";
  constructor(public readonly source: GroupSource) {
    super(
      `group source is '${source}'; membership is mirrored upstream and cannot be edited here`,
    );
  }
}
