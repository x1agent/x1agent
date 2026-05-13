import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import { UploadId, type Upload, type UploadStatus } from "../../domain/upload.js";
import type {
  InsertUploadInput,
  UploadRepository,
} from "../../ports/upload-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  user_id: string;
  session_id: string | null;
  filename: string;
  mime: string;
  size_bytes: string | number;
  storage_key: string;
  status: UploadStatus;
  created_at: Date | string;
  expires_at: Date | string;
  attached_at: Date | string | null;
}

const SELECT = `
  id, user_id, session_id, filename, mime, size_bytes,
  storage_key, status, created_at, expires_at, attached_at
`;

function toUpload(r: Row): Upload {
  return {
    id: UploadId(r.id),
    userId: UserId(r.user_id),
    sessionId: r.session_id,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: Number(r.size_bytes),
    storageKey: r.storage_key,
    status: r.status,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    attachedAt: r.attached_at ? new Date(r.attached_at) : null,
  };
}

export class PostgresUploadRepository implements UploadRepository {
  constructor(private readonly sql: Sql) {}

  async insert(input: InsertUploadInput): Promise<Upload> {
    const rows = await this.sql<Row[]>`
      INSERT INTO uploads (
        id, user_id, session_id, filename, mime, size_bytes,
        storage_key, status, created_at, expires_at
      ) VALUES (
        ${input.id}, ${input.userId}, ${input.sessionId}, ${input.filename},
        ${input.mime}, ${input.sizeBytes}, ${input.storageKey},
        ${input.status}, ${input.createdAt}, ${input.expiresAt}
      )
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toUpload(rows[0]!);
  }

  async findById(id: UploadId): Promise<Upload | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM uploads WHERE id = ${id}
    `;
    return rows[0] ? toUpload(rows[0]) : null;
  }

  async markReady(id: UploadId, mime: string, sizeBytes: number): Promise<void> {
    await this.sql`
      UPDATE uploads
         SET status = 'ready', mime = ${mime}, size_bytes = ${sizeBytes}
       WHERE id = ${id} AND status = 'pending'
    `;
  }

  async markAttached(
    id: UploadId,
    sessionId: string,
    expiresAt: Date,
    attachedAt: Date,
  ): Promise<void> {
    await this.sql`
      UPDATE uploads
         SET status = 'attached',
             session_id = COALESCE(session_id, ${sessionId}),
             attached_at = ${attachedAt},
             expires_at = ${expiresAt}
       WHERE id = ${id} AND status IN ('ready','attached')
    `;
  }

  async markDeleted(id: UploadId): Promise<void> {
    await this.sql`
      UPDATE uploads SET status = 'deleted' WHERE id = ${id}
    `;
  }

  async reapExpired(now: Date, limit: number): Promise<Upload[]> {
    const rows = await this.sql<Row[]>`
      UPDATE uploads
         SET status = 'expired'
       WHERE id IN (
         SELECT id FROM uploads
          WHERE expires_at < ${now}
            AND status IN ('pending','ready')
          ORDER BY expires_at ASC
          LIMIT ${limit}
       )
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return rows.map(toUpload);
  }

  async listForStorageDeletion(limit: number): Promise<Upload[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM uploads
       WHERE status IN ('expired','deleted')
       ORDER BY expires_at ASC
       LIMIT ${limit}
    `;
    return rows.map(toUpload);
  }

  async hardDeleteOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM uploads
       WHERE status IN ('expired','deleted')
         AND expires_at < ${cutoff}
       RETURNING id
    `;
    return rows.length;
  }

  async countRecentByUser(userId: UserId, since: Date): Promise<number> {
    const rows = await this.sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM uploads
       WHERE user_id = ${userId} AND created_at >= ${since}
    `;
    return Number(rows[0]?.c ?? 0);
  }
}
