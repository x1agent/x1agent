import type postgres from "postgres";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import { CollectionHandle } from "@x1agent/domain-graph";
import {
  CollectionId,
  CollectionProviderType,
  CollectionSlug,
  type AgentCollectionAttachment,
  type Collection,
} from "../../domain/collection.js";
import type {
  AttachInput,
  CollectionRepository,
  CreateCollectionInput,
  UpdateCollectionInput,
} from "../../ports/collection-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  provider_type: string;
  backend_handle: string;
  settings: Record<string, unknown>;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AttachmentRow {
  agent_id: string;
  collection_id: string;
  is_default: boolean;
  attached_at: Date | string;
}

const SELECT = `
  id, workspace_id, name, slug, description, provider_type,
  backend_handle, settings, created_by, created_at, updated_at
`;

function toCollection(r: Row): Collection {
  return {
    id: CollectionId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    name: r.name,
    slug: CollectionSlug(r.slug),
    description: r.description,
    providerType: CollectionProviderType(r.provider_type),
    backendHandle: CollectionHandle(r.backend_handle),
    settings: r.settings ?? {},
    createdBy: r.created_by ? UserId(r.created_by) : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

function toAttachment(r: AttachmentRow): AgentCollectionAttachment {
  return {
    agentId: AgentId(r.agent_id),
    collectionId: CollectionId(r.collection_id),
    isDefault: r.is_default,
    attachedAt: new Date(r.attached_at),
  };
}

export class PostgresCollectionRepository implements CollectionRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateCollectionInput): Promise<Collection> {
    const rows = await this.sql<Row[]>`
      INSERT INTO collections
        (workspace_id, name, slug, description, provider_type,
         backend_handle, settings, created_by)
      VALUES
        (${input.workspaceId}, ${input.name}, ${input.slug},
         ${input.description}, ${input.providerType},
         ${input.backendHandle},
         ${this.sql.json(input.settings as never)},
         ${input.createdBy})
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toCollection(rows[0]!);
  }

  async findById(id: CollectionId): Promise<Collection | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM collections WHERE id = ${id}
    `;
    return rows[0] ? toCollection(rows[0]) : null;
  }

  async findBySlug(
    workspaceId: WorkspaceId,
    slug: CollectionSlug,
  ): Promise<Collection | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM collections
      WHERE workspace_id = ${workspaceId} AND slug = ${slug}
    `;
    return rows[0] ? toCollection(rows[0]) : null;
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly Collection[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM collections
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
    return rows.map(toCollection);
  }

  async update(
    id: CollectionId,
    patch: UpdateCollectionInput,
  ): Promise<Collection> {
    const rows = await this.sql<Row[]>`
      UPDATE collections SET
        name        = ${patch.name === undefined ? this.sql`name` : patch.name},
        description = ${
          patch.description === undefined ? this.sql`description` : patch.description
        },
        settings    = ${
          patch.settings === undefined
            ? this.sql`settings`
            : this.sql.json(patch.settings as never)
        },
        updated_at  = now()
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toCollection(rows[0]!);
  }

  async delete(id: CollectionId): Promise<void> {
    await this.sql`DELETE FROM collections WHERE id = ${id}`;
  }

  async listForAgent(
    agentId: AgentId,
  ): Promise<readonly AgentCollectionAttachment[]> {
    const rows = await this.sql<AttachmentRow[]>`
      SELECT agent_id, collection_id, is_default, attached_at
      FROM agent_collections WHERE agent_id = ${agentId}
    `;
    return rows.map(toAttachment);
  }

  async listCollectionsForAgent(
    agentId: AgentId,
  ): Promise<readonly (Collection & { isDefault: boolean })[]> {
    const rows = await this.sql<(Row & { is_default: boolean })[]>`
      SELECT ${this.sql.unsafe(
        SELECT
          .split(",")
          .map((c) => `c.${c.trim()}`)
          .join(", "),
      )}, ac.is_default
      FROM agent_collections ac
      JOIN collections c ON c.id = ac.collection_id
      WHERE ac.agent_id = ${agentId}
      ORDER BY ac.is_default DESC, c.name
    `;
    return rows.map((r) => ({ ...toCollection(r), isDefault: r.is_default }));
  }

  async attach(input: AttachInput): Promise<AgentCollectionAttachment> {
    const result = await this.sql.begin(async (tx) => {
      if (input.isDefault) {
        await tx`
          UPDATE agent_collections SET is_default = false
          WHERE agent_id = ${input.agentId}
        `;
      }
      const rows = await tx<AttachmentRow[]>`
        INSERT INTO agent_collections (agent_id, collection_id, is_default)
        VALUES (${input.agentId}, ${input.collectionId}, ${input.isDefault})
        ON CONFLICT (agent_id, collection_id) DO UPDATE
          SET is_default = EXCLUDED.is_default
        RETURNING agent_id, collection_id, is_default, attached_at
      `;
      return rows[0]!;
    });
    return toAttachment(result);
  }

  async detach(
    agentId: AgentId,
    collectionId: CollectionId,
  ): Promise<void> {
    await this.sql`
      DELETE FROM agent_collections
      WHERE agent_id = ${agentId} AND collection_id = ${collectionId}
    `;
  }

  async syncAttachments(
    agentId: AgentId,
    _workspaceId: WorkspaceId,
    collectionIds: readonly CollectionId[],
    defaultCollectionId: CollectionId | null,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        DELETE FROM agent_collections WHERE agent_id = ${agentId}
      `;
      for (const cid of collectionIds) {
        const isDefault = cid === defaultCollectionId;
        await tx`
          INSERT INTO agent_collections (agent_id, collection_id, is_default)
          VALUES (${agentId}, ${cid}, ${isDefault})
        `;
      }
    });
  }
}
