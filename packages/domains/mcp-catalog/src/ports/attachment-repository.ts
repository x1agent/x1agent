import type { Attachment, AttachmentEnvValue } from "../domain/attachment.js";

export interface AttachmentUpsertInput {
  agentId: string;
  catalogEntryId: string;
  envJson: Record<string, AttachmentEnvValue>;
  toolScopesGranted: string[];
  createdBy: string | null;
}

export interface AttachmentRepository {
  /** All attachments for an agent. Used by the UI and the pod-spec generator. */
  listByAgent(agentId: string): Promise<Attachment[]>;
  getById(agentId: string, id: string): Promise<Attachment | null>;
  upsert(input: AttachmentUpsertInput): Promise<Attachment>;
  delete(agentId: string, id: string): Promise<boolean>;

  /**
   * Returns the catalog entry IDs that have at least one attachment.
   * Used to gate deletion of catalog entries (RESTRICT FK).
   */
  countByCatalogEntry(catalogEntryId: string): Promise<number>;
}
