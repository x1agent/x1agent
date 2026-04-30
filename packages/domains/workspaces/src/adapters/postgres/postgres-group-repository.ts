import type postgres from "postgres";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  CreateGroupInput,
  GroupRepository,
} from "../../ports/group-repository.js";
import {
  Group,
  GroupId,
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
  source: string;
  external_id: string | null;
  rule: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toGroup(r: Row): Group {
  return {
    id: GroupId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    slug: r.slug,
    name: r.name,
    source: r.source as GroupSource,
    externalId: r.external_id,
    rule: r.rule,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

const SELECT = `id, workspace_id, slug, name, source, external_id, rule, created_at, updated_at`;

export class PostgresGroupRepository implements GroupRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateGroupInput): Promise<Group> {
    const source = input.source ?? "manual";
    try {
      const rows = await this.sql<Row[]>`
        INSERT INTO groups
          (workspace_id, slug, name, source, external_id, rule)
        VALUES
          (${input.workspaceId}, ${input.slug}, ${input.name},
           ${source}, ${input.externalId ?? null},
           ${input.rule ? this.sql.json(input.rule) : null})
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      return toGroup(rows[0]!);
    } catch (err) {
      // 23505 = unique_violation. The constraint is (workspace_id, slug).
      if ((err as { code?: string })?.code === "23505") {
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

  async findBySlug(workspaceId: WorkspaceId, slug: string) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM groups
      WHERE workspace_id = ${workspaceId} AND slug = ${slug}
    `;
    return rows[0] ? toGroup(rows[0]) : null;
  }

  async listByWorkspace(workspaceId: WorkspaceId) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM groups
      WHERE workspace_id = ${workspaceId}
      ORDER BY name ASC
    `;
    return rows.map(toGroup);
  }

  async updateName(id: GroupId, name: string): Promise<Group> {
    const rows = await this.sql<Row[]>`
      UPDATE groups SET name = ${name}, updated_at = now()
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    if (!rows[0]) throw new GroupNotFoundError(String(id));
    return toGroup(rows[0]);
  }

  async delete(id: GroupId): Promise<void> {
    await this.sql`DELETE FROM groups WHERE id = ${id}`;
  }

  async addMember(id: GroupId, userId: UserId): Promise<void> {
    await this.sql`
      INSERT INTO group_members (group_id, user_id)
      VALUES (${id}, ${userId})
      ON CONFLICT DO NOTHING
    `;
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

  async listGroupIdsForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<readonly GroupId[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT g.id FROM groups g
      JOIN group_members m ON m.group_id = g.id
      WHERE g.workspace_id = ${workspaceId}
        AND m.user_id = ${userId}
        AND g.source IN ('manual', 'scim')
    `;
    return rows.map((r) => GroupId(r.id));
  }
}
