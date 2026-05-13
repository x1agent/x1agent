import type postgres from "postgres";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  CreateGroupInput,
  GroupListEntry,
  GroupMemberEntry,
  GroupRepository,
  UpdateGroupInput,
} from "../../ports/group-repository.js";
import {
  Group,
  GroupId,
  GroupNameTakenError,
  GroupNotFoundError,
  GroupSlugTakenError,
  type GroupSource,
} from "../../domain/group.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  source: string;
  external_id: string | null;
  rule: Record<string, unknown> | null;
  created_by: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toGroup(r: Row): Group {
  return {
    id: GroupId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    slug: r.slug,
    name: r.name,
    description: r.description,
    source: r.source as GroupSource,
    externalId: r.external_id,
    rule: r.rule,
    createdBy: r.created_by ? UserId(r.created_by) : null,
    archivedAt: r.archived_at ? new Date(r.archived_at) : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

const SELECT = `id, workspace_id, slug, name, description, source,
                external_id, rule, created_by, archived_at,
                created_at, updated_at`;

// Postgres unique_violation code. Centralized so the catch sites read
// like "is this the unique-constraint we expected?" rather than
// magic-number checks.
const PG_UNIQUE_VIOLATION = "23505";

export class PostgresGroupRepository implements GroupRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateGroupInput): Promise<Group> {
    const source = input.source ?? "manual";
    try {
      const rows = await this.sql<Row[]>`
        INSERT INTO groups
          (workspace_id, slug, name, description, source,
           external_id, rule, created_by)
        VALUES
          (${input.workspaceId}, ${input.slug}, ${input.name},
           ${input.description ?? null},
           ${source}, ${input.externalId ?? null},
           ${input.rule ? this.sql.json(input.rule as postgres.JSONValue) : null},
           ${input.createdBy ?? null})
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      return toGroup(rows[0]!);
    } catch (err) {
      // Two unique constraints can fire here:
      //   1. (workspace_id, slug)             — from migration 027
      //   2. (workspace_id, lower(name)) WHERE active AND manual
      //                                       — from migration 051
      // The `constraint_name` field on the postgres error lets us tell
      // them apart so we throw the user-facing error that maps to the
      // right HTTP code (409 name_taken vs 409 group_slug_taken).
      const e = err as { code?: string; constraint_name?: string };
      if (e.code === PG_UNIQUE_VIOLATION) {
        if (e.constraint_name === "groups_ws_name_active_manual") {
          throw new GroupNameTakenError(input.name);
        }
        throw new GroupSlugTakenError(input.slug);
      }
      throw err;
    }
  }

  async findById(id: GroupId): Promise<Group | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM groups WHERE id = ${id}
    `;
    return rows[0] ? toGroup(rows[0]) : null;
  }

  async findActiveInWorkspace(
    id: GroupId,
    workspaceId: WorkspaceId,
  ): Promise<Group | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM groups
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND archived_at IS NULL
    `;
    return rows[0] ? toGroup(rows[0]) : null;
  }

  async findBySlug(workspaceId: WorkspaceId, slug: string) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM groups
      WHERE workspace_id = ${workspaceId} AND slug = ${slug}
    `;
    return rows[0] ? toGroup(rows[0]) : null;
  }

  async findActiveByName(workspaceId: WorkspaceId, name: string) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM groups
      WHERE workspace_id = ${workspaceId}
        AND lower(name) = lower(${name})
        AND archived_at IS NULL
        AND source = 'manual'
      LIMIT 1
    `;
    return rows[0] ? toGroup(rows[0]) : null;
  }

  async listActiveByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly GroupListEntry[]> {
    // Single round-trip with a LEFT JOIN + COUNT so we don't
    // N+1-query for each group's member count. GROUP BY g.id is
    // sufficient — id is the primary key, so functional dependency
    // covers every selected column without listing them.
    const rows = await this.sql<(Row & { member_count: string | number })[]>`
      SELECT g.id, g.workspace_id, g.slug, g.name, g.description,
             g.source, g.external_id, g.rule, g.created_by,
             g.archived_at, g.created_at, g.updated_at,
             COUNT(m.user_id)::int AS member_count
      FROM groups g
      LEFT JOIN group_members m ON m.group_id = g.id
      WHERE g.workspace_id = ${workspaceId}
        AND g.archived_at IS NULL
      GROUP BY g.id
      ORDER BY g.name ASC
    `;
    return rows.map((r) => ({
      ...toGroup(r),
      memberCount: Number(r.member_count),
    }));
  }

  async listByWorkspace(workspaceId: WorkspaceId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM groups
      WHERE workspace_id = ${workspaceId}
      ORDER BY name ASC
    `;
    return rows.map(toGroup);
  }

  async update(id: GroupId, input: UpdateGroupInput): Promise<Group> {
    // We could build the SET clause dynamically, but the postgres
    // template-literal driver doesn't compose well with conditional
    // assignments. Two explicit branches keeps the SQL legible.
    if (input.name !== undefined && input.description !== undefined) {
      const rows = await this.sql<Row[]>`
        UPDATE groups
        SET name = ${input.name},
            description = ${input.description},
            updated_at = now()
        WHERE id = ${id}
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      return this.assertUpdated(rows, id, input.name ?? null);
    }
    if (input.name !== undefined) {
      try {
        const rows = await this.sql<Row[]>`
          UPDATE groups SET name = ${input.name}, updated_at = now()
          WHERE id = ${id}
          RETURNING ${this.sql.unsafe(SELECT)}
        `;
        return this.assertUpdated(rows, id, input.name);
      } catch (err) {
        const e = err as { code?: string; constraint_name?: string };
        if (
          e.code === PG_UNIQUE_VIOLATION &&
          e.constraint_name === "groups_ws_name_active_manual"
        ) {
          throw new GroupNameTakenError(input.name);
        }
        throw err;
      }
    }
    if (input.description !== undefined) {
      const rows = await this.sql<Row[]>`
        UPDATE groups SET description = ${input.description}, updated_at = now()
        WHERE id = ${id}
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      return this.assertUpdated(rows, id, null);
    }
    // No fields to update; just re-read the row.
    const existing = await this.findById(id);
    if (!existing) throw new GroupNotFoundError(String(id));
    return existing;
  }

  private assertUpdated(
    rows: Row[],
    id: GroupId,
    triedName: string | null,
  ): Group {
    if (!rows[0]) throw new GroupNotFoundError(String(id));
    return toGroup(rows[0]);
  }

  async updateName(id: GroupId, name: string): Promise<Group> {
    return this.update(id, { name });
  }

  async archive(id: GroupId): Promise<void> {
    // Idempotent: WHERE archived_at IS NULL guards a re-archive from
    // bumping the timestamp.
    await this.sql`
      UPDATE groups SET archived_at = now(), updated_at = now()
      WHERE id = ${id} AND archived_at IS NULL
    `;
  }

  async delete(id: GroupId): Promise<void> {
    await this.sql`DELETE FROM groups WHERE id = ${id}`;
  }

  async addMember(
    id: GroupId,
    userId: UserId,
    addedBy: UserId | null = null,
  ): Promise<void> {
    await this.sql`
      INSERT INTO group_members (group_id, user_id, added_by)
      VALUES (${id}, ${userId}, ${addedBy})
      ON CONFLICT DO NOTHING
    `;
  }

  async addMembers(
    id: GroupId,
    userIds: readonly UserId[],
    addedBy: UserId | null = null,
  ): Promise<number> {
    if (userIds.length === 0) return 0;
    // De-dup the input array — the same user appearing twice in one
    // request would otherwise hit ON CONFLICT and confuse the rowCount.
    const unique = Array.from(new Set(userIds.map((u) => String(u))));
    const rows = unique.map((u) => ({
      group_id: id,
      user_id: u,
      added_by: addedBy,
    }));
    const result = await this.sql`
      INSERT INTO group_members ${this.sql(rows, "group_id", "user_id", "added_by")}
      ON CONFLICT DO NOTHING
    `;
    return result.count;
  }

  async removeMember(id: GroupId, userId: UserId): Promise<void> {
    await this.sql`
      DELETE FROM group_members
      WHERE group_id = ${id} AND user_id = ${userId}
    `;
  }

  async listMembers(id: GroupId): Promise<readonly UserId[]> {
    const rows = await this.sql<{ user_id: string }[]>`
      SELECT user_id FROM group_members WHERE group_id = ${id}
      ORDER BY added_at DESC
    `;
    return rows.map((r) => UserId(r.user_id));
  }

  async listMemberships(id: GroupId): Promise<readonly GroupMemberEntry[]> {
    const rows = await this.sql<
      {
        group_id: string;
        user_id: string;
        added_at: Date | string;
        added_by: string | null;
      }[]
    >`
      SELECT group_id, user_id, added_at, added_by
      FROM group_members WHERE group_id = ${id}
      ORDER BY added_at ASC
    `;
    return rows.map((r) => ({
      groupId: GroupId(r.group_id),
      userId: UserId(r.user_id),
      addedAt: new Date(r.added_at),
      addedBy: r.added_by ? UserId(r.added_by) : null,
    }));
  }

  async listGroupIdsForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<readonly GroupId[]> {
    // Archived groups are excluded. The grants resolver should not
    // resolve a 'group' subject_kind grant via a soft-deleted group;
    // historical access lives in the share row's recipient snapshot
    // (X1A-109), not in live membership.
    const rows = await this.sql<{ id: string }[]>`
      SELECT g.id FROM groups g
      JOIN group_members m ON m.group_id = g.id
      WHERE g.workspace_id = ${workspaceId}
        AND m.user_id = ${userId}
        AND g.source IN ('manual', 'scim')
        AND g.archived_at IS NULL
    `;
    return rows.map((r) => GroupId(r.id));
  }

  async listGroupsForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<readonly Group[]> {
    const rows = await this.sql<Row[]>`
      SELECT g.id, g.workspace_id, g.slug, g.name, g.description,
             g.source, g.external_id, g.rule, g.created_by,
             g.archived_at, g.created_at, g.updated_at
      FROM groups g
      JOIN group_members m ON m.group_id = g.id
      WHERE g.workspace_id = ${workspaceId}
        AND m.user_id = ${userId}
        AND g.archived_at IS NULL
      ORDER BY g.name ASC
    `;
    return rows.map(toGroup);
  }
}
