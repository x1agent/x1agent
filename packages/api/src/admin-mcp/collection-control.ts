import type postgres from "postgres";
import {
  CollectionProviderType,
  CollectionSlug,
  buildCollectionAddress,
  type ProviderGateway,
} from "@x1agent/domain-collections";
import { UserId, WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";

type Sql = postgres.Sql<Record<string, unknown>>;

interface CollectionRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  provider_type: string;
  backend_handle: string;
  backend_namespace: string;
  settings: Record<string, unknown>;
  provisioning_status: string;
  last_error_code: string | null;
  last_error_message: string | null;
  provision_attempt: number;
  last_provisioned_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, workspace_id, name, slug, description, provider_type,
  backend_handle, backend_namespace, settings, provisioning_status,
  last_error_code, last_error_message, provision_attempt,
  last_provisioned_at, created_by, created_at, updated_at
`;

function serialize(row: CollectionRow): Record<string, unknown> {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    provider_type: row.provider_type,
    backend: {
      namespace: row.backend_namespace,
      handle: row.backend_handle,
    },
    settings: row.settings,
    status: row.provisioning_status,
    status_reason:
      row.last_error_code || row.last_error_message
        ? {
            code: row.last_error_code,
            message: row.last_error_message,
          }
        : null,
    provision_attempt: row.provision_attempt,
    last_provisioned_at: row.last_provisioned_at?.toISOString() ?? null,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    configuration_revision: row.updated_at.toISOString(),
    poll_after_seconds:
      row.provisioning_status === "pending" ||
      row.provisioning_status === "provisioning" ||
      row.provisioning_status === "deleting"
        ? 5
        : null,
  };
}

export function safeProviderError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  const candidateCode =
    typeof candidate?.code === "string" ? candidate.code.toLowerCase() : "";
  return {
    code: /^[a-z][a-z0-9_.-]{0,99}$/.test(candidateCode)
      ? candidateCode
      : "provisioning_failed",
    message: "collection provider operation failed",
  };
}

export class AdminMcpCollectionControl {
  constructor(
    private readonly sql: Sql,
    private readonly providers: ProviderGateway,
  ) {}

  async list(workspaceId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.sql<CollectionRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM collections
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC, id DESC
    `;
    return rows.map(serialize);
  }

  async get(
    workspaceId: string,
    collectionId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<CollectionRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM collections
      WHERE workspace_id = ${workspaceId} AND id = ${collectionId}
      LIMIT 1
    `;
    return rows[0] ? serialize(rows[0]) : null;
  }

  async create(input: {
    workspaceId: string;
    workspaceSlug: string;
    actorUserId: string;
    name: string;
    slug: string;
    description?: string | null;
    providerType?: string;
    settings?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const slug = CollectionSlug(input.slug);
    const providerType = CollectionProviderType(
      input.providerType ?? "surrealdb",
    );
    const address = buildCollectionAddress(
      WorkspaceSlug(input.workspaceSlug),
      slug,
    );
    const row = await this.sql.begin(async (tx) => {
      const existing = await tx<CollectionRow[]>`
        SELECT ${tx.unsafe(COLUMNS)} FROM collections
        WHERE workspace_id = ${input.workspaceId} AND slug = ${slug}
        LIMIT 1
      `;
      if (existing[0]) {
        throw Object.assign(new Error("collection slug is already in use"), {
          code: "collection_slug_taken",
        });
      }
      const rows = await tx<CollectionRow[]>`
        INSERT INTO collections (
          workspace_id, name, slug, description, provider_type,
          backend_handle, backend_namespace, settings, created_by,
          provisioning_status
        ) VALUES (
          ${WorkspaceId(input.workspaceId)}, ${input.name.trim()}, ${slug},
          ${input.description ?? null}, ${providerType}, ${address.database},
          ${address.namespace}, ${tx.json((input.settings ?? {}) as never)},
          ${UserId(input.actorUserId)}, 'pending'
        )
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      await tx`
        INSERT INTO collection_provision_operations (collection_id, operation)
        VALUES (${rows[0]!.id}, 'provision')
      `;
      return rows[0]!;
    });
    return serialize(row);
  }

  async update(input: {
    workspaceId: string;
    collectionId: string;
    expectedUpdatedAt: string;
    name?: string;
    description?: string | null;
    settings?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const rows = await this.sql<CollectionRow[]>`
      UPDATE collections SET
        name = ${input.name === undefined ? this.sql`name` : input.name.trim()},
        description = ${
          input.description === undefined
            ? this.sql`description`
            : input.description
        },
        settings = ${
          input.settings === undefined
            ? this.sql`settings`
            : this.sql.json(input.settings as never)
        },
        updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.collectionId}
        AND updated_at = ${new Date(input.expectedUpdatedAt)}
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    return rows[0] ? serialize(rows[0]) : null;
  }

  async retry(
    workspaceId: string,
    collectionId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<CollectionRow[]>`
        UPDATE collections
        SET provisioning_status = 'pending', last_error_code = NULL,
            last_error_message = NULL, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${collectionId}
          AND provisioning_status = 'failed'
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      if (!rows[0]) return null;
      await tx`
        INSERT INTO collection_provision_operations (collection_id, operation)
        VALUES (${collectionId}, 'provision')
        ON CONFLICT (collection_id, operation)
          WHERE status IN ('pending', 'processing') DO NOTHING
      `;
      return serialize(rows[0]);
    });
  }

  async requestDelete(
    workspaceId: string,
    collectionId: string,
  ): Promise<{ collection: Record<string, unknown>; attachmentCount: number } | null> {
    return this.sql.begin(async (tx) => {
      const countRows = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM agent_collections ac
        JOIN collections c ON c.id = ac.collection_id
        WHERE c.workspace_id = ${workspaceId} AND c.id = ${collectionId}
      `;
      const attachmentCount = countRows[0]?.count ?? 0;
      if (attachmentCount > 0) {
        const existing = await tx<CollectionRow[]>`
          SELECT ${tx.unsafe(COLUMNS)} FROM collections
          WHERE workspace_id = ${workspaceId} AND id = ${collectionId}
        `;
        return existing[0]
          ? { collection: serialize(existing[0]), attachmentCount }
          : null;
      }
      const rows = await tx<CollectionRow[]>`
        UPDATE collections SET provisioning_status = 'deleting', updated_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${collectionId}
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      if (!rows[0]) return null;
      await tx`
        INSERT INTO collection_provision_operations (collection_id, operation)
        VALUES (${collectionId}, 'deprovision')
        ON CONFLICT (collection_id, operation)
          WHERE status IN ('pending', 'processing') DO NOTHING
      `;
      return { collection: serialize(rows[0]), attachmentCount: 0 };
    });
  }

  async processNext(): Promise<boolean> {
    const operation = await this.sql.begin(async (tx) => {
      const rows = await tx<{
        id: string;
        collection_id: string;
        operation: "provision" | "deprovision";
      }[]>`
        SELECT id, collection_id, operation
        FROM collection_provision_operations
        WHERE available_at <= now()
          AND (
            status = 'pending'
            OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
          )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT 1
      `;
      if (!rows[0]) return null;
      await tx`
        UPDATE collection_provision_operations
        SET status = 'processing', attempt = attempt + 1,
            started_at = now(), updated_at = now()
        WHERE id = ${rows[0].id}
      `;
      if (rows[0].operation === "provision") {
        await tx`
          UPDATE collections SET provisioning_status = 'provisioning',
            provision_attempt = provision_attempt + 1, updated_at = now()
          WHERE id = ${rows[0].collection_id}
        `;
      }
      return rows[0];
    });
    if (!operation) return false;
    const rows = await this.sql<CollectionRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM collections
      WHERE id = ${operation.collection_id}
    `;
    const collection = rows[0];
    if (!collection) return true;
    try {
      const address = {
        namespace: collection.backend_namespace as never,
        database: collection.backend_handle as never,
      };
      if (operation.operation === "provision") {
        await this.providers.provision(
          CollectionProviderType(collection.provider_type),
          address,
          collection.settings,
        );
        await this.sql`
          UPDATE collections SET provisioning_status = 'ready',
            last_error_code = NULL, last_error_message = NULL,
            last_provisioned_at = now(), updated_at = now()
          WHERE id = ${collection.id}
        `;
      } else {
        await this.providers.deprovision(
          CollectionProviderType(collection.provider_type),
          address,
        );
        await this.sql`DELETE FROM collections WHERE id = ${collection.id}`;
      }
      await this.sql`
        UPDATE collection_provision_operations
        SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = ${operation.id}
      `;
    } catch (error) {
      const safe = safeProviderError(error);
      await this.sql.begin(async (tx) => {
        await tx`
          UPDATE collection_provision_operations SET status = 'failed',
            last_error_code = ${safe.code}, last_error_message = ${safe.message},
            completed_at = now(), updated_at = now()
          WHERE id = ${operation.id}
        `;
        await tx`
          UPDATE collections SET provisioning_status = 'failed',
            last_error_code = ${safe.code}, last_error_message = ${safe.message},
            updated_at = now() WHERE id = ${collection.id}
        `;
      });
    }
    return true;
  }
}
