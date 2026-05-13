import { UserId } from "@x1agent/kernel";
import { UploadId, type Upload, type UploadStatus } from "../domain/upload.js";
import type {
  InsertUploadInput,
  UploadRepository,
} from "../ports/upload-repository.js";

/**
 * In-memory UploadRepository for unit tests. Mirrors the Postgres
 * adapter's contract without I/O. Exposes `rows` so tests can inspect /
 * preload state directly.
 */
export class InMemoryUploadRepository implements UploadRepository {
  readonly rows = new Map<string, Upload>();

  async insert(input: InsertUploadInput): Promise<Upload> {
    const row: Upload = {
      id: input.id,
      userId: input.userId,
      sessionId: input.sessionId,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
      status: input.status,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      attachedAt: null,
    };
    this.rows.set(input.id, row);
    return row;
  }

  async findById(id: UploadId): Promise<Upload | null> {
    return this.rows.get(id) ?? null;
  }

  async markReady(id: UploadId, mime: string, sizeBytes: number): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.status !== "pending") return;
    this.rows.set(id, { ...r, status: "ready", mime, sizeBytes });
  }

  async markAttached(
    id: UploadId,
    sessionId: string,
    expiresAt: Date,
    attachedAt: Date,
  ): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    this.rows.set(id, {
      ...r,
      status: "attached",
      sessionId: r.sessionId ?? sessionId,
      expiresAt,
      attachedAt,
    });
  }

  async markDeleted(id: UploadId): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    this.rows.set(id, { ...r, status: "deleted" });
  }

  async reapExpired(now: Date, limit: number): Promise<Upload[]> {
    const out: Upload[] = [];
    for (const r of this.rows.values()) {
      if (out.length >= limit) break;
      if (r.expiresAt < now && (r.status === "pending" || r.status === "ready")) {
        const upd: Upload = { ...r, status: "expired" };
        this.rows.set(r.id, upd);
        out.push(upd);
      }
    }
    return out;
  }

  async listForStorageDeletion(limit: number): Promise<Upload[]> {
    const candidates: Upload[] = [];
    for (const r of this.rows.values()) {
      if (r.status === "expired" || r.status === "deleted") candidates.push(r);
    }
    candidates.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    return candidates.slice(0, limit);
  }

  async hardDeleteOlderThan(cutoff: Date): Promise<number> {
    let n = 0;
    for (const r of [...this.rows.values()]) {
      if (
        (r.status === "expired" || r.status === "deleted") &&
        r.expiresAt < cutoff
      ) {
        this.rows.delete(r.id);
        n += 1;
      }
    }
    return n;
  }

  async countRecentByUser(userId: UserId, since: Date): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.userId === userId && r.createdAt >= since) n += 1;
    }
    return n;
  }

  /** Test-only helper to force a status without going through use cases. */
  forceStatus(id: UploadId, status: UploadStatus): void {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, status });
  }
}
